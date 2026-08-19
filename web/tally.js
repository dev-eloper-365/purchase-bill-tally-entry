// Tally XML-HTTP integration: master lookups, ledger matching, voucher
// building, and the send loop. All requests go through the local bridge
// (POST /api/tally) since TallyPrime sends no CORS headers and a page
// cannot talk to port 9000 directly.
//
// Nothing in this file fires automatically. Every Tally call is triggered
// by an explicit button in app.js, one action at a time.

const MASTERS = {
  voucherType: 'Imported Steam Coal Purchase @ 18 % GST',
  stockItem: 'Imported Steam Coal - TR',
  godown: 'Main Location',
  purchaseLedger: 'Imported Steam Coal Purchase  -18% GST', // note: two spaces before "-18%", verified against 154 real vouchers
  cgstLedger: 'Input CGST 9%',
  sgstLedger: 'Input SGST 9%',
  roundOffLedger: 'ROUND OFF',
  tcsLedgerOld: 'TCS RECEIVABLE F.Y.25-26',
  tcsLedgerNew: 'TCS RECEIVABLE F.Y.26-27',
  tcsCutoverIso: '2026-04-01',
  unit: 'MTS',
};

// Verified against a real DGRPL voucher (No. 8409, 19-Aug-26, party
// HONESTFALCON RESOURCES PRIVATE LIMITED-PURCHASE, 42.270 MTS @
// 7950.00/MTS) - DGRPL is not "GJ with different data", it's a genuinely
// different master set (confirmed: every tax figure on that voucher still
// matches computeTax()'s existing formula exactly, so only the NAMES
// differ here, not the arithmetic). This covers Gujarat/intrastate
// purchases from the already-known suppliers only. DGRPL also has a real,
// heavily-used interstate pattern (IGST as a single ledger instead of a
// CGST+SGST split, state-suffixed stock items/voucher types like
// "Imported Steam Coal @18% KTK") that is NOT covered here - that's a real
// GST-rule difference, not a naming one, and deliberately out of scope.
const MASTERS_DGRPL = {
  voucherType: 'Steam Coal Purchase @  18% GST', // two spaces before "18%" - confirmed via real voucher XML, not just the Tally UI's rendering
  stockItem: 'Imported Steam Coal - TR', // identical to GJ
  godown: 'Main Location', // identical to GJ
  purchaseLedger: 'Steam Coal Purchase @ 18% GST', // one space - a DIFFERENT string than voucherType above despite looking similar
  cgstLedger: 'CGST INPUT 9%', // word order swapped vs GJ's "Input CGST 9%"
  sgstLedger: 'SGST INPUT 9%',
  roundOffLedger: 'ROUNDING OFF', // vs GJ's "ROUND OFF"
  tcsLedgerOld: 'TCS RECEIVABLE F.Y.25-26', // confirmed identical to GJ's string via live probe
  tcsLedgerNew: 'TCS RECEIVABLE FY 2026-27', // no periods - different format than GJ's "F.Y.26-27", confirmed via real voucher
  tcsCutoverIso: '2026-04-01',
  unit: 'MTS',
};

const MASTERS_BY_COMPANY = {
  'DELTA GLOBAL PRIVATE LIMITED GJ 2025-26': MASTERS,
  'Delta Global Resources Private Limited 2025-26': MASTERS_DGRPL,
};

// Falls back to GJ's masters for any company not explicitly configured -
// matches today's behavior everywhere except DGRPL.
function getMasters(companyName) {
  return MASTERS_BY_COMPANY[companyName] || MASTERS;
}

function xmlEscape(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function pickTcsLedger(invoiceDateIso, masters) {
  if (!invoiceDateIso) return masters.tcsLedgerNew;
  return invoiceDateIso >= masters.tcsCutoverIso ? masters.tcsLedgerNew : masters.tcsLedgerOld;
}

async function tallyPost(xml) {
  const resp = await fetch('/api/tally', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: xml,
  });
  const text = await resp.text();
  if (!resp.ok) {
    let msg = text;
    try {
      const j = JSON.parse(text);
      msg = j.error || text;
    } catch (e) {}
    throw new Error(`Bridge/Tally error: ${msg}`);
  }
  return text;
}

async function getConfig() {
  const resp = await fetch('/api/config');
  return resp.json();
}

// ---- Master data probes (read-only) ------------------------------------

async function fetchCompanyList() {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>List of Companies</ID></HEADER><BODY><DESC></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  const names = [];
  const re = /<COMPANY NAME="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) names.push(m[1]);
  return names;
}

// Narrow single-object probe: checks whether one specific ledger exists in
// the given company, without pulling the full ledger collection. This is
// the safe way to test a company before trusting it with a full fetch -
// a full TYPE=Collection ledger export against DGPL GC 2025-26 previously
// crashed Tally with a memory access violation.
async function probeLedgerExists(companyName, ledgerName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>Ledger</SUBTYPE><ID TYPE="Name">${xmlEscape(
    ledgerName
  )}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><FETCHLIST><FETCH>Name</FETCH><FETCH>Parent</FETCH><FETCH>PartyGSTIN</FETCH></FETCHLIST></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  const found = /<NAME[^>]*>([^<]*)<\/NAME>/i.test(text) || text.includes(`<LEDGER NAME="${ledgerName.replace(/"/g, '')}"`);
  return { exists: found, raw: text };
}

async function probeStockItemExists(companyName, stockItemName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>StockItem</SUBTYPE><ID TYPE="Name">${xmlEscape(
    stockItemName
  )}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><FETCHLIST><FETCH>Name</FETCH></FETCHLIST></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  return { exists: /<NAME[^>]*>([^<]*)<\/NAME>/i.test(text), raw: text };
}

async function probeVoucherTypeExists(companyName, voucherTypeName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Object</TYPE><SUBTYPE>VoucherType</SUBTYPE><ID TYPE="Name">${xmlEscape(
    voucherTypeName
  )}</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><FETCHLIST><FETCH>Name</FETCH></FETCHLIST></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  return { exists: /<NAME[^>]*>([^<]*)<\/NAME>/i.test(text), raw: text };
}

// Full masters check for the currently configured company: every ledger,
// stock item and voucher type this app depends on, probed one at a time.
async function checkRequiredMasters(companyName) {
  const masters = getMasters(companyName);
  const results = [];
  const ledgerNames = [
    masters.purchaseLedger,
    masters.cgstLedger,
    masters.sgstLedger,
    masters.roundOffLedger,
    masters.tcsLedgerOld,
    masters.tcsLedgerNew,
  ];
  for (const name of ledgerNames) {
    const r = await probeLedgerExists(companyName, name);
    results.push({ kind: 'Ledger', name, exists: r.exists });
    await sleep(150);
  }
  // Stock item is no longer a single shared master - it's per-row (default
  // "Imported Steam Coal - TR", overridable to any real Tally stock item),
  // checked per-row during preflight instead, same as the party ledger.
  const vtR = await probeVoucherTypeExists(companyName, masters.voucherType);
  results.push({ kind: 'VoucherType', name: masters.voucherType, exists: vtR.exists });
  return results;
}

// ---- Stock item list (only called explicitly, one company) -------------
// Same narrow Collection+NATIVEMETHOD shape as fetchLedgers/fetchGroups -
// proven safe against this Tally, unlike a full unrestricted object dump.
//
// This company file's stock item list is NOT scoped to purchase goods -
// it spans thousands of items belonging to an entirely unrelated business
// line (confirmed live: stock groups for things like apparel sit
// alongside "Goods"). An unfiltered fetch would dump all of that into the
// dropdown. Filtered server-side to items directly under the "Goods"
// stock group, which is exactly the coal/iron/ore item set this app
// deals with (~35 items, confirmed against the real company).
async function fetchStockItems(companyName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AppStockItems</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="AppStockItems" ISMODIFY="No"><TYPE>StockItem</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><FILTER>AppGoodsFilter</FILTER></COLLECTION><SYSTEM TYPE="Formulae" NAME="AppGoodsFilter">$Parent = "Goods"</SYSTEM></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  const items = [];
  const re = /<STOCKITEM NAME="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) items.push({ name: decodeXmlEntities(m[1]) });
  return items;
}

// ---- Ledger list + group tree (only called explicitly, one company) ----

async function fetchLedgers(companyName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AppLedgers</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="AppLedgers" ISMODIFY="No"><TYPE>Ledger</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD><NATIVEMETHOD>PartyGSTIN</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  return parseLedgerXml(text);
}

function parseLedgerXml(text) {
  const ledgers = [];
  const re = /<LEDGER NAME="([^"]*)"[^>]*>([\s\S]*?)<\/LEDGER>/g;
  let m;
  while ((m = re.exec(text))) {
    const name = decodeXmlEntities(m[1]);
    const block = m[2];
    const parentM = block.match(/<PARENT[^>]*>([\s\S]*?)<\/PARENT>/);
    const gstinM = block.match(/<PARTYGSTIN[^>]*>([\s\S]*?)<\/PARTYGSTIN>/);
    ledgers.push({
      name,
      parent: parentM ? decodeXmlEntities(parentM[1]) : '',
      gstin: gstinM ? decodeXmlEntities(gstinM[1]).trim() : '',
    });
  }
  return ledgers;
}

async function fetchGroups(companyName) {
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Collection</TYPE><ID>AppGroups</ID></HEADER><BODY><DESC><STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY></STATICVARIABLES><TDL><TDLMESSAGE><COLLECTION NAME="AppGroups" ISMODIFY="No"><TYPE>Group</TYPE><NATIVEMETHOD>Name</NATIVEMETHOD><NATIVEMETHOD>Parent</NATIVEMETHOD></COLLECTION></TDLMESSAGE></TDL></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  const map = {};
  const re = /<GROUP NAME="([^"]*)"[^>]*>([\s\S]*?)<\/GROUP>/g;
  let m;
  while ((m = re.exec(text))) {
    const name = decodeXmlEntities(m[1]);
    const parentM = m[2].match(/<PARENT[^>]*>([\s\S]*?)<\/PARENT>/);
    map[name] = parentM ? decodeXmlEntities(parentM[1]) : '';
  }
  return map;
}

function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#4;/g, '');
}

function groupRoot(groupName, groupMap, maxHops = 25) {
  let cur = groupName;
  const chain = [cur];
  let hops = 0;
  while (groupMap[cur] && hops < maxHops) {
    cur = groupMap[cur];
    chain.push(cur);
    hops++;
  }
  return chain; // chain[0] = original group, chain[last] = root
}

// A handful of ledgers are genuinely purchase-side but sit under a group
// that resolves through Sundry Debtors for reasons unrelated to buy/sell
// (e.g. grouped by salesperson name rather than counterparty role) - the
// "ignore sales" rule would otherwise wrongly exclude them too. Rather
// than weaken that rule generally (a name-pattern heuristic like "contains
// PURCHASE" could misfire on a differently-named ledger later), each
// exception is named exactly here so it's a deliberate, auditable
// decision, not a rule change. Add to this only when a ledger is
// confirmed correct despite its Tally group placement.
const CREDITOR_OVERRIDE_LEDGERS = new Set([
  'Jai Sai Coal Traders Private Limited (PURCHASE)',
]);

// A ledger counts as a purchase-side creditor if its group chain passes
// through "Sundry Creditors" before reaching the primary root. Anything
// resolving through "Sundry Debtors" is the sales side of the same
// supplier and must be excluded per the "ignore sales" rule.
function classifyLedger(ledger, groupMap) {
  if (CREDITOR_OVERRIDE_LEDGERS.has(ledger.name)) return 'creditor';
  const chain = groupRoot(ledger.parent, groupMap);
  if (chain.includes('Sundry Creditors')) return 'creditor';
  if (chain.includes('Sundry Debtors')) return 'debtor';
  return 'other';
}

function matchLedgersForGstin(gstin, ledgers, groupMap) {
  if (!gstin) return [];
  const candidates = ledgers
    .filter((l) => l.gstin === gstin)
    .map((l) => ({ ...l, cls: classifyLedger(l, groupMap) }));
  // creditors first, then others; debtors (sales side) are dropped entirely
  return candidates
    .filter((c) => c.cls !== 'debtor')
    .sort((a, b) => (a.cls === 'creditor' ? -1 : 1) - (b.cls === 'creditor' ? -1 : 1));
}

// ---- Duplicate check ------------------------------------------------

// Pulls existing voucher numbers/references for the target voucher type
// within a date window, once per batch. The voucher type in use has
// NUMBERINGMETHOD = None, so Tally itself will not stop a duplicate -
// this is the only guard.
async function fetchExistingVoucherKeys(companyName, fromIso, toIso) {
  const masters = getMasters(companyName);
  const fromT = fromIso.replace(/-/g, '');
  const toT = toIso.replace(/-/g, '');
  const xml = `<ENVELOPE><HEADER><VERSION>1</VERSION><TALLYREQUEST>Export</TALLYREQUEST><TYPE>Data</TYPE><ID>Voucher Register</ID></HEADER><BODY><DESC><STATICVARIABLES><SVEXPORTFORMAT>$$SysName:XML</SVEXPORTFORMAT><SVCURRENTCOMPANY>${xmlEscape(
    companyName
  )}</SVCURRENTCOMPANY><SVFROMDATE TYPE="Date">${fromT}</SVFROMDATE><SVTODATE TYPE="Date">${toT}</SVTODATE><VOUCHERTYPENAME>${xmlEscape(
    masters.voucherType
  )}</VOUCHERTYPENAME></STATICVARIABLES></DESC></BODY></ENVELOPE>`;
  const text = await tallyPost(xml);
  const keys = new Set();
  const re = /<VOUCHERNUMBER>([\s\S]*?)<\/VOUCHERNUMBER>/g;
  let m;
  while ((m = re.exec(text))) keys.add(decodeXmlEntities(m[1]).trim());
  return keys;
}

// ---- Voucher XML ------------------------------------------------------

function buildVoucherXml(row, companyName) {
  const masters = getMasters(companyName);
  const c = row.computed;
  const tcsLedger = pickTcsLedger(row.invoiceDate, masters);
  const totalRounded = c.total.toFixed(2);
  const taxable = c.taxable.toFixed(2);
  const qtyStr = `${row.qty} ${masters.unit}`;
  const rateStr = `${row.rate}/${masters.unit}`;

  // c.roundOff = total - preRound (positive when the whole-rupee total was
  // rounded UP from the exact sum, negative when rounded DOWN). For the
  // voucher's ledger entries to sum to zero, the ROUND OFF entry's AMOUNT
  // must be the NEGATION of that value - confirmed by hand-balancing
  // against a real posted voucher (roundOff=-0.12 there, but its XML
  // AMOUNT was +0.12) and by reproducing an exact 0.76 imbalance (2x the
  // round-off, wrong sign) in a voucher Tally rejected with this bug.
  // ISDEEMEDPOSITIVE is hardcoded Yes to match that same real voucher,
  // independent of the amount's sign.
  const roundOffBlock =
    Math.abs(c.roundOff) > 0.001
      ? `
   <LEDGERENTRIES.LIST>
    <LEDGERNAME>${xmlEscape(masters.roundOffLedger)}</LEDGERNAME>
    <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
    <AMOUNT>${(-c.roundOff).toFixed(2)}</AMOUNT>
   </LEDGERENTRIES.LIST>`
      : '';

  return `<ENVELOPE>
 <HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>
 <BODY><IMPORTDATA>
  <REQUESTDESC>
   <REPORTNAME>Vouchers</REPORTNAME>
   <STATICVARIABLES><SVCURRENTCOMPANY>${xmlEscape(companyName)}</SVCURRENTCOMPANY></STATICVARIABLES>
  </REQUESTDESC>
  <REQUESTDATA>
   <TALLYMESSAGE xmlns:UDF="TallyUDF">
    <VOUCHER VCHTYPE="${xmlEscape(masters.voucherType)}" ACTION="Create" OBJVIEW="Invoice Voucher View">
     <DATE>${row.invoiceDateTally}</DATE>
     <REFERENCEDATE>${row.invoiceDateTally}</REFERENCEDATE>
     <VOUCHERTYPENAME>${xmlEscape(masters.voucherType)}</VOUCHERTYPENAME>
     <VOUCHERNUMBER>${xmlEscape(row.invoiceNo)}</VOUCHERNUMBER>
     <REFERENCE>${xmlEscape(row.invoiceNo)}</REFERENCE>
     <PARTYLEDGERNAME>${xmlEscape(row.ledgerName)}</PARTYLEDGERNAME>
     <PARTYNAME>${xmlEscape(row.ledgerName)}</PARTYNAME>
     <PARTYGSTIN>${xmlEscape(row.supplierGSTIN || '')}</PARTYGSTIN>
     <PERSISTEDVIEW>Invoice Voucher View</PERSISTEDVIEW>
     <VCHENTRYMODE>Item Invoice</VCHENTRYMODE>
     <NARRATION>${xmlEscape(row.vehicleNo)}</NARRATION>
     <ALLINVENTORYENTRIES.LIST>
      <STOCKITEMNAME>${xmlEscape(row.stockItemName || masters.stockItem)}</STOCKITEMNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <RATE>${rateStr}</RATE>
      <ACTUALQTY>${qtyStr}</ACTUALQTY>
      <BILLEDQTY>${qtyStr}</BILLEDQTY>
      <AMOUNT>-${taxable}</AMOUNT>
      <ACCOUNTINGALLOCATIONS.LIST>
       <LEDGERNAME>${xmlEscape(masters.purchaseLedger)}</LEDGERNAME>
       <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
       <AMOUNT>-${taxable}</AMOUNT>
      </ACCOUNTINGALLOCATIONS.LIST>
      <BATCHALLOCATIONS.LIST>
       <GODOWNNAME>${xmlEscape(masters.godown)}</GODOWNNAME>
       <BATCHNAME>Primary Batch</BATCHNAME>
       <AMOUNT>-${taxable}</AMOUNT>
       <ACTUALQTY>${qtyStr}</ACTUALQTY>
       <BILLEDQTY>${qtyStr}</BILLEDQTY>
      </BATCHALLOCATIONS.LIST>
     </ALLINVENTORYENTRIES.LIST>
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(row.ledgerName)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE>
      <AMOUNT>${totalRounded}</AMOUNT>
      <BILLALLOCATIONS.LIST>
       <NAME>${xmlEscape(row.invoiceNo)}</NAME>
       <BILLTYPE>New Ref</BILLTYPE>
       <AMOUNT>${totalRounded}</AMOUNT>
      </BILLALLOCATIONS.LIST>
     </LEDGERENTRIES.LIST>
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(masters.cgstLedger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${c.cgst.toFixed(2)}</AMOUNT>
     </LEDGERENTRIES.LIST>
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(masters.sgstLedger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${c.sgst.toFixed(2)}</AMOUNT>
     </LEDGERENTRIES.LIST>
     <LEDGERENTRIES.LIST>
      <LEDGERNAME>${xmlEscape(tcsLedger)}</LEDGERNAME>
      <ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE>
      <AMOUNT>-${c.tcs.toFixed(2)}</AMOUNT>
     </LEDGERENTRIES.LIST>${roundOffBlock}
    </VOUCHER>
   </TALLYMESSAGE>
  </REQUESTDATA>
 </IMPORTDATA></BODY>
</ENVELOPE>`;
}

function parseVoucherResponse(text) {
  const created = /<CREATED>(\d+)<\/CREATED>/.exec(text);
  const errors = /<ERRORS>(\d+)<\/ERRORS>/.exec(text);
  const lineErrors = [];
  const leRe = /<LINEERROR>([\s\S]*?)<\/LINEERROR>/g;
  let m;
  while ((m = leRe.exec(text))) lineErrors.push(decodeXmlEntities(m[1]).trim());
  const exceptions = /<EXCEPTIONS>(\d+)<\/EXCEPTIONS>/.exec(text);

  const createdCount = created ? parseInt(created[1], 10) : 0;
  const errorCount = errors ? parseInt(errors[1], 10) : 0;

  return {
    success: createdCount > 0 && errorCount === 0 && lineErrors.length === 0,
    createdCount,
    errorCount,
    lineErrors,
    exceptions: exceptions ? parseInt(exceptions[1], 10) : 0,
    raw: text,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

window.Tally = {
  MASTERS,
  MASTERS_DGRPL,
  getMasters,
  getConfig,
  fetchCompanyList,
  probeLedgerExists,
  probeStockItemExists,
  probeVoucherTypeExists,
  checkRequiredMasters,
  fetchLedgers,
  fetchStockItems,
  fetchGroups,
  classifyLedger,
  matchLedgersForGstin,
  fetchExistingVoucherKeys,
  buildVoucherXml,
  parseVoucherResponse,
  tallyPost,
  pickTcsLedger,
  sleep,
};
