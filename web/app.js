// Orchestration: upload -> extract -> review table -> preflight -> send.
// No Tally call happens unless a button is explicitly clicked. Nothing
// here batches multiple vouchers into one Tally request - see tally.js,
// sendAll() posts one voucher per request and stops on the first failure.

let CONFIG = null;
let bills = [];
let nextId = 1;
let ledgersCache = null; // { ledgers, groupMap }
let mastersOk = null; // null = unknown, true/false after a check

const STATUS_LABEL = {
  extracting: 'extracting…',
  needs_review: 'needs review',
  ready: 'ready',
  duplicate: 'duplicate',
  sending: 'sending…',
  sent: 'sent',
  failed: 'failed',
  error: 'error',
};

function log(msg, level = 'info') {
  const box = document.getElementById('logBox');
  const time = new Date().toLocaleTimeString();
  const line = document.createElement('div');
  line.className = `log-line ${level}`;
  line.textContent = `[${time}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

function genId() {
  return nextId++;
}

function findRow(id) {
  return bills.find((b) => b.id === id);
}

// ---- init ---------------------------------------------------------------

async function init() {
  try {
    CONFIG = await Tally.getConfig();
  } catch (e) {
    log('Could not load config.json via bridge: ' + e.message, 'err');
    CONFIG = { environment: 'LOCAL', companyName: '(unknown)', tallyUrl: 'http://localhost:9000' };
  }
  const badge = document.getElementById('envBadge');
  badge.textContent = CONFIG.environment;
  badge.className = 'env-badge ' + (CONFIG.environment === 'SERVER' ? 'server' : 'local');
  populateCompanySelect([CONFIG.companyName], CONFIG.companyName);

  document.getElementById('companySelect').addEventListener('change', onCompanyChanged);
  document.getElementById('btnTestConnection').addEventListener('click', testConnection);
  document.getElementById('btnCheckMasters').addEventListener('click', checkMasters);
  document.getElementById('btnLoadLedgers').addEventListener('click', loadLedgers);
  document.getElementById('btnRunPreflight').addEventListener('click', runPreflight);
  document.getElementById('btnClearAll').addEventListener('click', clearAll);
  document.getElementById('btnSendAll').addEventListener('click', onSendAllClicked);

  const dropZone = document.getElementById('dropZone');
  const fileInput = document.getElementById('fileInput');
  dropZone.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => handleFiles(e.target.files));
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  document.getElementById('billsTbody').addEventListener('input', onTableInput);
  document.getElementById('billsTbody').addEventListener('change', onTableInput);
  document.getElementById('billsTbody').addEventListener('click', onTableClick);

  log('Ready. Bridge target: ' + CONFIG.tallyUrl + ' / company: ' + CONFIG.companyName);
}

// ---- connection / masters -----------------------------------------------

function populateCompanySelect(companyNames, selected) {
  const sel = document.getElementById('companySelect');
  sel.innerHTML = companyNames.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
  if (selected && companyNames.includes(selected)) sel.value = selected;
}

function onCompanyChanged(e) {
  const newCompany = e.target.value;
  if (!newCompany || newCompany === CONFIG.companyName) return;
  const old = CONFIG.companyName;
  CONFIG.companyName = newCompany;
  // Masters/ledger state is company-specific - anything checked against the
  // old company doesn't apply to the new one.
  ledgersCache = null;
  mastersOk = null;
  document.getElementById('mastersResult').innerHTML = '';
  document.getElementById('ledgersDatalist').innerHTML = '';
  for (const row of bills) {
    row.ledgerCandidates = [];
    row.manualLedgerEntry = true;
  }
  renderTable();
  log(`Switched active company: "${old}" -> "${newCompany}". Re-run "Check required masters" and "Load ledgers" for it before sending.`, 'info');
}

async function testConnection() {
  const statusEl = document.getElementById('connStatus');
  statusEl.textContent = 'checking…';
  try {
    const names = await Tally.fetchCompanyList();
    log('Companies open in Tally: ' + (names.join(', ') || '(none - Tally may have a dialog open)'));
    if (names.length > 0) populateCompanySelect(names, CONFIG.companyName);
    if (names.includes(CONFIG.companyName)) {
      statusEl.textContent = `OK - "${CONFIG.companyName}" is open.`;
      statusEl.style.color = 'var(--success)';
    } else {
      statusEl.textContent = `"${CONFIG.companyName}" is NOT open in Tally right now.`;
      statusEl.style.color = 'var(--destructive)';
    }
  } catch (e) {
    statusEl.textContent = 'Connection failed: ' + e.message;
    statusEl.style.color = 'var(--destructive)';
    log('Connection test failed: ' + e.message, 'err');
  }
}

async function checkMasters() {
  const resultEl = document.getElementById('mastersResult');
  resultEl.innerHTML = '<div class="small-dim">Checking each master one at a time (safe, narrow lookups)…</div>';
  log('Checking required masters in ' + CONFIG.companyName + ' …');
  try {
    const results = await Tally.checkRequiredMasters(CONFIG.companyName);
    mastersOk = results.every((r) => r.exists);
    resultEl.innerHTML = results
      .map(
        (r) =>
          `<div class="masters-check-row"><span class="${r.exists ? 'ok-dot' : 'bad-dot'}">${
            r.exists ? '✓' : '✗'
          }</span> ${r.kind}: ${r.name}</div>`
      )
      .join('');
    if (mastersOk) {
      log('All required masters exist in ' + CONFIG.companyName + '.', 'ok');
    } else {
      log('Some required masters are missing in ' + CONFIG.companyName + ' - sending will be blocked until they exist.', 'err');
    }
  } catch (e) {
    resultEl.innerHTML = `<div class="bad-dot">Check failed: ${e.message}</div>`;
    log('Masters check failed: ' + e.message, 'err');
    mastersOk = false;
  }
}

async function loadLedgers() {
  const ok = confirm(
    `This pulls the full ledger list from "${CONFIG.companyName}" in Tally.\n\n` +
      'A previous attempt to do this on this company crashed Tally (memory access violation). ' +
      'Only continue if you have confirmed the company is stable via "Check required masters" first.\n\n' +
      'Continue?'
  );
  if (!ok) return;
  log('Loading ledgers + groups from ' + CONFIG.companyName + ' …');
  try {
    const [ledgers, groupMap] = await Promise.all([
      Tally.fetchLedgers(CONFIG.companyName),
      Tally.fetchGroups(CONFIG.companyName),
    ]);
    ledgersCache = { ledgers, groupMap };
    const datalist = document.getElementById('ledgersDatalist');
    datalist.innerHTML = ledgers
      .map((l) => `<option value="${escapeHtml(l.name)}"></option>`)
      .join('');
    log(`Loaded ${ledgers.length} ledgers, ${Object.keys(groupMap).length} groups.`, 'ok');
    rematchAllRows();
    renderTable();
  } catch (e) {
    log('Failed to load ledgers: ' + e.message, 'err');
  }
}

function rematchAllRows() {
  if (!ledgersCache) return;
  for (const row of bills) {
    if (!row.supplierGSTIN) continue;
    const candidates = Tally.matchLedgersForGstin(row.supplierGSTIN, ledgersCache.ledgers, ledgersCache.groupMap);
    row.ledgerCandidates = candidates;
    if (!row.ledgerName && candidates.length > 0) {
      row.ledgerName = candidates[0].name;
    }
    // A previously typed/manual value that doesn't match any real
    // candidate can't be shown as a selected <option>, so keep it as free
    // text rather than silently discarding it in a dropdown.
    if (row.ledgerName && !candidates.some((c) => c.name === row.ledgerName)) {
      row.manualLedgerEntry = true;
    }
  }
}

// ---- upload / extraction --------------------------------------------------

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter((f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
  if (files.length === 0) {
    log('No PDF files in that selection.', 'err');
    return;
  }
  for (const file of files) {
    const row = {
      id: genId(),
      fileName: file.name,
      status: 'extracting',
      supplierGSTIN: '',
      supplierLabel: '',
      template: '',
      invoiceNo: '',
      invoiceDate: '',
      invoiceDateTally: '',
      vehicleNo: '',
      qty: null,
      rate: null,
      computed: null,
      printedTotal: null,
      ledgerName: '',
      ledgerCandidates: [],
      manualLedgerEntry: false,
      warnings: [],
      errors: [],
      tallyResult: null,
      expanded: false,
      rawText: '',
      showRawText: false,
    };
    bills.push(row);
    renderTable();
    extractOne(row.id, file);
  }
}

async function extractOne(id, file) {
  try {
    const ext = await BillExtract.extractBillFromFile(file);
    const row = findRow(id);
    if (!row) return;
    row.supplierGSTIN = ext.supplierGSTIN || '';
    row.supplierLabel = ext.supplierLabel || '';
    row.template = ext.template;
    row.invoiceNo = ext.invoiceNo;
    row.invoiceDate = ext.invoiceDate;
    row.invoiceDateTally = ext.invoiceDateTally;
    row.vehicleNo = ext.vehicleNo;
    row.qty = ext.qty;
    row.rate = ext.rate;
    row.computed = ext.computed;
    row.printedTotal = ext.printedTotal;
    row.warnings = ext.warnings;
    row.rawText = ext.rawText;
    row.status = 'needs_review';

    if (ledgersCache && row.supplierGSTIN) {
      row.ledgerCandidates = Tally.matchLedgersForGstin(row.supplierGSTIN, ledgersCache.ledgers, ledgersCache.groupMap);
      if (row.ledgerCandidates.length > 0) row.ledgerName = row.ledgerCandidates[0].name;
    }

    log(`Extracted ${file.name}: invoice ${row.invoiceNo || '?'}, ${row.qty || '?'} MTS @ ${row.rate || '?'}`);
    renderTable();
  } catch (e) {
    const row = findRow(id);
    if (row) {
      row.status = 'error';
      row.warnings = ['Extraction failed: ' + e.message];
      renderTable();
    }
    log(`Extraction failed for ${file.name}: ${e.message}`, 'err');
  }
}

function clearAll() {
  if (bills.some((b) => b.status === 'sending')) {
    alert('A send is in progress - wait for it to finish.');
    return;
  }
  bills = [];
  renderTable();
  log('Cleared all rows.');
}

// ---- table rendering ------------------------------------------------------

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmt(n) {
  return n == null || Number.isNaN(n) ? '' : n.toFixed(2);
}

function fmtDateDisplay(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}-${m}-${y}`;
}

// Static display cell: truncates with an ellipsis when the column is
// narrower than the content, full value always available via the native
// title tooltip on hover.
function ellipsisCell(value, extraClass) {
  const text = value == null || value === '' ? '' : String(value);
  if (!text) return `<td class="${extraClass || ''}"><span class="small-dim">—</span></td>`;
  return `<td class="ellipsis-cell ${extraClass || ''}" title="${escapeHtml(text)}">${escapeHtml(text)}</td>`;
}

function renderTable() {
  const tbody = document.getElementById('billsTbody');
  tbody.innerHTML = bills.map((row) => renderRow(row) + (row.expanded ? renderDetailRow(row) : '')).join('');
}

// A real <select> dropdown of the GSTIN-matched Tally ledgers (the
// "similar name companies" candidate list) whenever those are known;
// falls back to free-text entry only when ledgers haven't been loaded
// yet, no candidate matched, or the current value doesn't match any
// candidate (so a manual override never gets silently discarded).
function renderLedgerCell(row, locked) {
  const candidates = row.ledgerCandidates || [];
  const useManual = row.manualLedgerEntry || !ledgersCache || (row.supplierGSTIN && candidates.length === 0);

  if (useManual) {
    const placeholder = !ledgersCache
      ? 'load ledgers above first…'
      : candidates.length === 0
      ? 'no match - type ledger name…'
      : 'type ledger name…';
    const backToDropdown =
      ledgersCache && candidates.length > 0
        ? `<button class="small" data-id="${row.id}" data-action="use-dropdown" title="Switch back to matched ledgers" ${locked ? 'disabled' : ''}>&#8635;</button>`
        : '';
    return `<div class="ledger-cell"><input class="wide" list="ledgersDatalist" data-id="${row.id}" data-field="ledgerName" value="${escapeHtml(
      row.ledgerName
    )}" placeholder="${placeholder}" ${locked ? 'disabled' : ''} />${backToDropdown}</div>`;
  }

  const options = candidates
    .map(
      (c) =>
        `<option value="${escapeHtml(c.name)}" ${c.name === row.ledgerName ? 'selected' : ''}>${escapeHtml(c.name)}${
          c.cls === 'creditor' ? '' : ' (check group)'
        }</option>`
    )
    .join('');

  return `<select class="wide" data-id="${row.id}" data-field="ledgerName" ${locked ? 'disabled' : ''}>
    ${options}
    <option value="__manual__">Type manually…</option>
  </select>`;
}

function renderRow(row) {
  const locked = row.status === 'sending' || row.status === 'sent';
  const c = row.computed || {};
  // Bills vary on which total they print: some (Agarwal) print the exact
  // unrounded sum with no round-off line at all; others (Honestfalcon, MP
  // Fuel) already round to the nearest rupee and show their own ROUND OFF
  // line, same as the voucher will. Accept a match against either figure -
  // only flag a real mismatch when neither one lines up with the bill.
  const preRoundTotal = c.total != null ? c.total - (c.roundOff || 0) : null;
  const matchesRounded = c.total != null && row.printedTotal != null && Math.abs(c.total - row.printedTotal) <= 0.02;
  const matchesPreRound =
    preRoundTotal != null && row.printedTotal != null && Math.abs(preRoundTotal - row.printedTotal) <= 0.02;
  const mismatch = row.printedTotal != null && c.total != null && !matchesRounded && !matchesPreRound;
  const totalHtml = mismatch
    ? `<span class="diff-flag" title="Bill prints ${fmt(row.printedTotal)}, computed ${fmt(c.total)} (${fmt(preRoundTotal)} before round-off)">${fmt(c.total)} &#9888;</span>`
    : fmt(c.total) || '<span class="small-dim">-</span>';

  const noteCount = (row.warnings || []).length + (row.errors || []).length;
  const flagHtml = noteCount
    ? `<span class="note-dot" title="${noteCount} note(s) - expand row for detail">${noteCount}</span>`
    : '';

  const supplierText = row.supplierLabel || row.supplierGSTIN || '';

  return `<tr data-row-id="${row.id}" class="${row.expanded ? 'row-expanded' : ''}">
    <td class="col-expand"><button class="chevron" data-action="toggle" data-id="${row.id}" title="${row.expanded ? 'Hide' : 'Show'} details and edit fields">${row.expanded ? '&#9662;' : '&#9656;'}</button></td>
    <td class="col-file small-dim" title="${escapeHtml(row.fileName)}">${escapeHtml(row.fileName)}</td>
    <td><span class="badge ${row.status}">${STATUS_LABEL[row.status] || row.status}</span></td>
    ${supplierText ? ellipsisCell(supplierText, 'col-supplier') : '<td><span class="diff-flag">unknown</span></td>'}
    ${ellipsisCell(row.ledgerName, 'col-ledger')}
    ${ellipsisCell(row.invoiceNo, 'col-invno')}
    <td>${row.invoiceDate ? fmtDateDisplay(row.invoiceDate) : '<span class="small-dim">—</span>'}</td>
    ${ellipsisCell(row.vehicleNo, 'col-vehicle')}
    <td class="col-total">${row.qty != null ? row.qty : '<span class="small-dim">—</span>'}</td>
    <td class="col-total">${row.rate != null ? fmt(row.rate) : '<span class="small-dim">—</span>'}</td>
    <td class="small-dim col-total">${fmt(c.tcs)}</td>
    <td class="col-total">${totalHtml}</td>
    <td class="col-flags">${flagHtml}</td>
    <td class="col-actions"><button class="small" data-id="${row.id}" data-action="remove" ${locked ? 'disabled' : ''}>&times;</button></td>
  </tr>`;
}

function renderDetailRow(row) {
  const locked = row.status === 'sending' || row.status === 'sent';
  const c = row.computed || {};
  const notes = [...(row.warnings || []), ...(row.errors || [])];
  const notesHtml = notes.length
    ? notes.map((w) => `<div class="detail-note">${escapeHtml(w)}</div>`).join('')
    : '<div class="small-dim">No warnings.</div>';

  return `<tr class="detail-row" data-detail-for="${row.id}">
    <td></td>
    <td colspan="12">
      <div class="detail-grid">
        <div class="detail-block detail-edit">
          <div class="detail-label">Ledger</div>
          ${renderLedgerCell(row, locked)}
        </div>
        <div class="detail-block detail-edit">
          <div class="detail-label">Invoice No</div>
          <input data-id="${row.id}" data-field="invoiceNo" value="${escapeHtml(row.invoiceNo)}" ${locked ? 'disabled' : ''} />
        </div>
        <div class="detail-block detail-edit">
          <div class="detail-label">Date</div>
          <input type="date" data-id="${row.id}" data-field="invoiceDate" value="${escapeHtml(row.invoiceDate)}" ${locked ? 'disabled' : ''} />
        </div>
        <div class="detail-block detail-edit">
          <div class="detail-label">Vehicle / Narration</div>
          <input data-id="${row.id}" data-field="vehicleNo" value="${escapeHtml(row.vehicleNo)}" ${locked ? 'disabled' : ''} />
        </div>
        <div class="detail-block detail-edit">
          <div class="detail-label">Qty (MTS)</div>
          <input type="number" step="0.001" data-id="${row.id}" data-field="qty" value="${row.qty ?? ''}" ${locked ? 'disabled' : ''} />
        </div>
        <div class="detail-block detail-edit">
          <div class="detail-label">Rate</div>
          <input type="number" step="0.01" data-id="${row.id}" data-field="rate" value="${row.rate ?? ''}" ${locked ? 'disabled' : ''} />
        </div>
      </div>
      <div class="detail-grid" style="margin-top:16px;">
        <div class="detail-block">
          <div class="detail-label">Supplier</div>
          <div>${escapeHtml(row.supplierGSTIN) || '<span class="small-dim">GSTIN not detected</span>'}</div>
          ${row.supplierLabel ? `<div class="small-dim">${escapeHtml(row.supplierLabel)}</div>` : ''}
        </div>
        <div class="detail-block">
          <div class="detail-label">Computed tax (used for the voucher)</div>
          <table class="mini-table">
            <tr><td>Taxable</td><td>${fmt(c.taxable)}</td></tr>
            <tr><td>CGST 9%</td><td>${fmt(c.cgst)}</td></tr>
            <tr><td>SGST 9%</td><td>${fmt(c.sgst)}</td></tr>
            <tr><td>TCS 2%</td><td>${fmt(c.tcs)}</td></tr>
            <tr><td>Round off</td><td>${fmt(c.roundOff)}</td></tr>
            <tr class="mini-total"><td>Total</td><td>${fmt(c.total)}</td></tr>
          </table>
        </div>
        <div class="detail-block">
          <div class="detail-label">Printed on bill</div>
          <div>${row.printedTotal != null ? fmt(row.printedTotal) : '<span class="small-dim">not parsed</span>'}</div>
        </div>
        <div class="detail-block detail-notes">
          <div class="detail-label">Notes</div>
          ${notesHtml}
        </div>
      </div>
      <div style="margin-top:10px;">
        <button class="small" data-id="${row.id}" data-action="toggle-raw">${row.showRawText ? 'Hide' : 'Show'} raw extracted text</button>
      </div>
      ${
        row.showRawText
          ? `<textarea class="raw-text-box" readonly onclick="this.select()">${escapeHtml(row.rawText || '(no text extracted)')}</textarea>`
          : ''
      }
    </td>
    <td></td>
  </tr>`;
}

function onTableInput(e) {
  const id = Number(e.target.dataset.id);
  const field = e.target.dataset.field;
  if (!id || !field) return;
  const row = findRow(id);
  if (!row) return;

  let value = e.target.value;
  if (field === 'qty' || field === 'rate') {
    value = value === '' ? null : parseFloat(value);
  }
  if (field === 'ledgerName' && value === '__manual__') {
    row.manualLedgerEntry = true;
    row.ledgerName = '';
    renderTable();
    return;
  }
  row[field] = value;

  if (field === 'invoiceDate') {
    row.invoiceDateTally = BillExtract.isoToTally(value);
  }
  if (field === 'qty' || field === 'rate') {
    if (row.qty && row.rate) {
      row.computed = BillExtract.computeTax(row.qty, row.rate);
    } else {
      row.computed = null;
    }
  }

  if (row.status !== 'extracting' && row.status !== 'sending' && row.status !== 'sent') {
    row.status = 'needs_review';
    row.errors = [];
  }
  // Qty/Rate live in the expanded detail row and drive the Total/TCS
  // display, but re-rendering on every keystroke ('input') would replace
  // the input's DOM node and kick focus out mid-type. Only re-render on
  // 'change' (blur / commit), so typing stays uninterrupted and totals
  // refresh once the value is settled.
  if ((field === 'qty' || field === 'rate') && e.type === 'change') renderTable();
}

function onTableClick(e) {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const row = findRow(id);

  if (btn.dataset.action === 'remove') {
    bills = bills.filter((b) => b.id !== id);
    renderTable();
  } else if (btn.dataset.action === 'toggle') {
    if (row) {
      row.expanded = !row.expanded;
      renderTable();
    }
  } else if (btn.dataset.action === 'toggle-raw') {
    if (row) {
      row.showRawText = !row.showRawText;
      renderTable();
    }
  } else if (btn.dataset.action === 'use-dropdown') {
    if (row) {
      row.manualLedgerEntry = false;
      if (row.ledgerCandidates && row.ledgerCandidates.length > 0 && !row.ledgerCandidates.some((c) => c.name === row.ledgerName)) {
        row.ledgerName = row.ledgerCandidates[0].name;
      }
      renderTable();
    }
  }
}

// ---- preflight --------------------------------------------------------

function validateRowLocally(row) {
  const errors = [];
  if (!row.ledgerName) errors.push('Ledger not set.');
  if (!row.invoiceNo) errors.push('Invoice number missing.');
  if (!row.invoiceDate) errors.push('Invoice date missing/invalid.');
  if (!row.qty || row.qty <= 0) errors.push('Quantity missing.');
  if (!row.rate || row.rate <= 0) errors.push('Rate missing.');
  if (!row.computed) errors.push('Tax not computed (needs qty and rate).');
  return errors;
}

async function runPreflight() {
  const statusEl = document.getElementById('preflightStatus');
  const candidates = bills.filter((b) => b.status === 'needs_review' || b.status === 'duplicate' || b.status === 'failed');
  if (candidates.length === 0) {
    statusEl.textContent = 'Nothing to validate.';
    return;
  }

  document.getElementById('btnRunPreflight').disabled = true;
  statusEl.textContent = 'Checking shared masters…';
  log('Preflight: checking shared masters first.');

  try {
    const masterResults = await Tally.checkRequiredMasters(CONFIG.companyName);
    mastersOk = masterResults.every((r) => r.exists);
    if (!mastersOk) {
      const missing = masterResults.filter((r) => !r.exists).map((r) => `${r.kind}: ${r.name}`);
      log('Preflight aborted - missing masters in Tally: ' + missing.join(' | '), 'err');
      statusEl.textContent = 'Aborted - required masters missing in Tally. See log.';
      for (const row of candidates) {
        row.errors = ['Required Tally masters missing (purchase/tax/stock ledgers). See masters check above.'];
      }
      renderTable();
      return;
    }
  } catch (e) {
    log('Preflight aborted - masters check failed: ' + e.message, 'err');
    statusEl.textContent = 'Aborted - could not reach Tally.';
    return;
  }

  // local validation first, no Tally calls
  const locallyValid = [];
  for (const row of candidates) {
    row.errors = validateRowLocally(row);
    if (row.errors.length === 0) locallyValid.push(row);
  }

  // per-row ledger existence, one request at a time
  statusEl.textContent = `Checking ${locallyValid.length} ledger name(s) in Tally…`;
  for (const row of locallyValid) {
    try {
      const r = await Tally.probeLedgerExists(CONFIG.companyName, row.ledgerName);
      if (!r.exists) {
        row.errors.push(`Ledger "${row.ledgerName}" not found in Tally - name must match exactly.`);
      }
      await Tally.sleep(150);
    } catch (e) {
      row.errors.push('Ledger check failed: ' + e.message);
    }
  }

  const stillValid = locallyValid.filter((r) => r.errors.length === 0);

  // duplicate check across the whole batch's date span, one request
  if (stillValid.length > 0) {
    const dates = stillValid.map((r) => r.invoiceDate).filter(Boolean).sort();
    const fromIso = addDays(dates[0], -3);
    const toIso = addDays(dates[dates.length - 1], 3);
    statusEl.textContent = 'Checking for duplicate invoice numbers already in Tally…';
    try {
      const existingKeys = await Tally.fetchExistingVoucherKeys(CONFIG.companyName, fromIso, toIso);
      for (const row of stillValid) {
        if (existingKeys.has(row.invoiceNo)) {
          row.status = 'duplicate';
          row.errors.push('This invoice number already exists in Tally for this voucher type.');
        }
      }
      log(`Duplicate check: ${existingKeys.size} existing voucher(s) in range ${fromIso}..${toIso}.`);
    } catch (e) {
      log('Duplicate check failed, treating all rows as unverified: ' + e.message, 'err');
      for (const row of stillValid) row.errors.push('Could not verify duplicate status: ' + e.message);
    }
  }

  let readyCount = 0;
  for (const row of candidates) {
    if (row.status === 'duplicate') continue;
    if (row.errors.length === 0) {
      row.status = 'ready';
      readyCount++;
    } else {
      row.status = 'needs_review';
    }
  }

  document.getElementById('btnRunPreflight').disabled = false;
  statusEl.textContent = `Preflight done: ${readyCount} ready, ${candidates.length - readyCount} need attention.`;
  log(`Preflight complete: ${readyCount}/${candidates.length} ready to send.`, readyCount > 0 ? 'ok' : 'info');
  renderTable();
}

function addDays(iso, days) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- send ---------------------------------------------------------------

function onSendAllClicked() {
  if (CONFIG.environment === 'SERVER') {
    renderServerConfirm();
    return;
  }
  sendAll();
}

function renderServerConfirm() {
  const box = document.getElementById('serverConfirmBox');
  box.innerHTML = `<div class="confirm-box">
    This is pointed at the <b>production Tally server</b> (company: ${escapeHtml(CONFIG.companyName)}).
    Type the company name exactly to confirm you want to send real vouchers.
    <div style="margin-top:8px;">
      <input type="text" id="serverConfirmInput" placeholder="${escapeHtml(CONFIG.companyName)}" />
      <button id="serverConfirmBtn" class="danger">Confirm and send</button>
      <button id="serverConfirmCancel">Cancel</button>
    </div>
  </div>`;
  document.getElementById('serverConfirmCancel').addEventListener('click', () => (box.innerHTML = ''));
  document.getElementById('serverConfirmBtn').addEventListener('click', () => {
    const val = document.getElementById('serverConfirmInput').value.trim();
    if (val === CONFIG.companyName) {
      box.innerHTML = '';
      sendAll();
    } else {
      alert('Company name did not match. Not sending.');
    }
  });
}

async function sendAll() {
  const statusEl = document.getElementById('sendStatus');
  const ready = bills.filter((b) => b.status === 'ready');
  if (ready.length === 0) {
    statusEl.textContent = 'No rows are ready. Run preflight first.';
    return;
  }

  document.getElementById('btnSendAll').disabled = true;
  let sentCount = 0;

  for (let i = 0; i < ready.length; i++) {
    const row = ready[i];
    row.status = 'sending';
    renderTable();
    statusEl.textContent = `Sending ${i + 1}/${ready.length}: ${row.fileName} (invoice ${row.invoiceNo})…`;
    log(`Sending voucher for ${row.fileName} (invoice ${row.invoiceNo})…`);

    try {
      const xml = Tally.buildVoucherXml(row, CONFIG.companyName);
      const respText = await Tally.tallyPost(xml);
      const parsed = Tally.parseVoucherResponse(respText);
      row.tallyResult = parsed;

      if (parsed.success) {
        row.status = 'sent';
        sentCount++;
        log(`Created in Tally: ${row.fileName} (invoice ${row.invoiceNo}).`, 'ok');
      } else {
        row.status = 'failed';
        row.errors = parsed.lineErrors.length
          ? parsed.lineErrors
          : [`Tally reported ${parsed.errorCount} error(s), ${parsed.createdCount} created.`];
        log(`Tally rejected ${row.fileName}: ${row.errors.join(' | ')}`, 'err');
        renderTable();
        statusEl.textContent = `Stopped after failure on "${row.fileName}". ${sentCount} sent, ${
          ready.length - i - 1
        } not attempted.`;
        document.getElementById('btnSendAll').disabled = false;
        return;
      }
    } catch (e) {
      row.status = 'failed';
      row.errors = [e.message];
      log(`Send failed for ${row.fileName}: ${e.message}`, 'err');
      renderTable();
      statusEl.textContent = `Stopped after failure on "${row.fileName}". ${sentCount} sent, ${
        ready.length - i - 1
      } not attempted.`;
      document.getElementById('btnSendAll').disabled = false;
      return;
    }

    renderTable();
    await Tally.sleep(400);
  }

  statusEl.textContent = `Done: ${sentCount}/${ready.length} sent successfully.`;
  log(`Batch complete: ${sentCount}/${ready.length} sent.`, 'ok');
  document.getElementById('btnSendAll').disabled = false;
}

init();
