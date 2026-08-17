// PDF -> field extraction.
//
// Each supplier's PDF text layer comes out of pdf.js in a different order
// (some are label-then-value in a clean sequence, some group all labels,
// then all colons, then all values as separate blocks). There is no single
// regex strategy that survives all three, so a supplier is identified first
// (by a GSTIN that is known to belong to it), then a template specific to
// that supplier's layout runs. Unknown suppliers fall back to a best-effort
// generic scan and are always flagged for review.
//
// Nothing here writes to Tally. Every extracted field lands in an editable
// table row before it can be sent.

const SELF_GSTIN = '24AAECD5633K1ZN'; // Delta Global Private Limited - never a supplier

const KNOWN_SUPPLIERS = {
  '24AACCA8468K1ZD': { label: 'Agarwal Coal Corporation Pvt Ltd', template: 'agarwal' },
  '24AAQCM6956J1ZS': { label: 'MP Fuel Solution Private Limited', template: 'mpfuel' },
  '24AAGCH8484E1ZF': { label: 'Honestfalcon Resources Pvt Ltd', template: 'honestfalcon' },
};

const GSTIN_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z]\d[A-Z]\d[A-Z]\b/g; // trailing PAN checksum char is often OCR-safe as [A-Z]
// Real GSTIN checksum position varies in OCR'd text; use a looser 15-char scan as a fallback.
const GSTIN_LOOSE_RE = /\b\d{2}[A-Z0-9]{13}\b/g;

function stripCommas(numStr) {
  if (numStr == null) return NaN;
  return parseFloat(String(numStr).replace(/,/g, '').trim());
}

function findAllGstins(text) {
  const found = new Set();
  for (const re of [GSTIN_RE, GSTIN_LOOSE_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (/^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]$/.test(m[0])) {
        found.add(m[0]);
      }
    }
  }
  return Array.from(found);
}

function detectSupplier(text) {
  for (const gstin of Object.keys(KNOWN_SUPPLIERS)) {
    if (text.includes(gstin)) {
      return { gstin, ...KNOWN_SUPPLIERS[gstin] };
    }
  }
  // Unknown supplier: any GSTIN present that is not our own is a candidate.
  const all = findAllGstins(text).filter((g) => g !== SELF_GSTIN);
  if (all.length === 1) {
    return { gstin: all[0], label: null, template: 'generic' };
  }
  return { gstin: null, label: null, template: 'generic', ambiguousGstins: all };
}

// Normalises "16-08-2026", "17/08/2026", "16-Aug-26", "16-Aug-2026" to {iso, tallyDate}
function parseBillDate(raw) {
  if (!raw) return null;
  const s = raw.trim();

  let m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if (m) {
    const [, d, mo, y] = m;
    return isoFromParts(y, mo, d);
  }

  const months = {
    jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
    jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
  };
  m = s.match(/^(\d{1,2})[-\/]([A-Za-z]{3,})[-\/](\d{2,4})$/);
  if (m) {
    const [, d, monName, yRaw] = m;
    const mo = months[monName.toLowerCase().slice(0, 3)];
    if (!mo) return null;
    let y = yRaw.length === 2 ? 2000 + parseInt(yRaw, 10) : parseInt(yRaw, 10);
    return isoFromParts(y, mo, d);
  }

  return null;
}

function isoFromParts(y, mo, d) {
  y = parseInt(y, 10);
  mo = parseInt(mo, 10);
  d = parseInt(d, 10);
  if (!y || !mo || !d) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return iso;
}

function isoToTally(iso) {
  if (!iso) return '';
  return iso.replace(/-/g, '');
}

// ---- Per-supplier templates -----------------------------------------

// NOTE ON SPACING: pdf.js emits one text item per word (sometimes per
// sub-word run) for several of these layouts, and joining them inserts
// variable whitespace - "Invoice No." can come back as "Invoice   No."
// with multiple spaces. Every literal multi-word phrase below therefore
// uses \s+ between words, never a hardcoded single space, or the pattern
// silently fails to match at the first word boundary.

function extractAgarwal(text) {
  const out = { warnings: [] };

  let m = text.match(/Invoice\s+No:\s*\n?\s*([A-Za-z0-9\/\-]+)/i);
  out.invoiceNo = m ? m[1].trim() : null;

  m = text.match(/\bDated\b\s*\n?\s*(\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4})/);
  out.invoiceDateRaw = m ? m[1].trim() : null;

  m = text.match(/Motor\s+Vehicle\s+No\.?\s*\/?\s*R?\s*R?\s*No\.?\s*\n?\s*([A-Z]{2}[A-Z0-9]{4,12})/i);
  out.vehicleNo = m ? m[1].trim().toUpperCase() : null;

  m = text.match(/Imported\s+Coal\s+(\d{4,8})\s+([\d.]+)\s+([\d.,]+)\s+MT\s+([\d.,]+)/i);
  if (m) {
    out.qty = stripCommas(m[2]);
    out.rate = stripCommas(m[3]);
    out.taxableFromBill = stripCommas(m[4]);
  }

  m = text.match(/\bTotal\b\s+[\d.]+\s+([\d,]+\.\d{2})/);
  out.printedTotal = m ? stripCommas(m[1]) : null;

  return out;
}

function extractMpFuel(text) {
  const out = { warnings: [] };

  let m = text.match(
    /Invoice\s+No\.\s*\n\s*Invoice\s+Date\s*\n\s*Delivery\s+Ex\s*\n\s*:\s*\n\s*:\s*\n\s*:\s*\n\s*([A-Za-z0-9\/\-]+)\s*\n\s*(\d{1,2}\/\d{1,2}\/\d{4})/i
  );
  if (m) {
    out.invoiceNo = m[1].trim();
    out.invoiceDateRaw = m[2].trim();
  } else {
    // fallback: look for the two fields independently
    m = text.match(/Invoice\s+No\.[^\n]*\n[\s\S]{0,60}?:\s*\n\s*([A-Za-z0-9\/\-]+)/i);
    out.invoiceNo = m ? m[1].trim() : null;
    m = text.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    out.invoiceDateRaw = m ? m[1].trim() : null;
    out.warnings.push('Invoice no / date parsed via fallback pattern - verify.');
  }

  m = text.match(
    /Vehicle\s+No\s*\n\s*Lr\.?\s*No\.?\s*\n\s*Transport\s*\n\s*:\s*\n\s*:\s*\n\s*:\s*\n\s*([A-Z0-9]{6,12})/i
  );
  out.vehicleNo = m ? m[1].trim().toUpperCase() : null;
  if (!out.vehicleNo) {
    m = text.match(/\b([A-Z]{2}\d{1,2}[A-Z]{1,2}\d{3,4})\b/);
    out.vehicleNo = m ? m[1].toUpperCase() : null;
  }

  m = text.match(/Imported\s+Coal\s+[\d\-]+\s+\d{4,8}\s+([\d.]+)\s+([\d.,]+)\s+([\d.,]+)/i);
  if (m) {
    out.qty = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
    out.taxableFromBill = stripCommas(m[3]);
  }

  m = text.match(/Grand\s+Total\s+([\d,]+\.\d{2})/i);
  out.printedTotal = m ? stripCommas(m[1]) : null;

  // Fallback: two shorter, differently-anchored numbers survive even when
  // the item-table row above does not. Order is not assumed either way -
  // this layout has been seen printing the taxable value BETWEEN the two
  // "Sub Total" labels ("Sub Total 3,67,449.00 Sub Total"), and the item
  // count either before or after the word "Total".
  if (!out.qty || !out.rate) {
    const subTotalM =
      text.match(/Sub\s+Total\s+([\d,]+\.\d{2})\s+Sub\s+Total/i) ||
      text.match(/Sub\s+Total\s+Sub\s+Total\s+([\d,]+\.\d{2})/i);
    const qtyM =
      text.match(/(\d+\.\d{2,3})\s+Total\b/) || text.match(/\bTotal\s+(\d+\.\d{2,3})\s*(?:\n|$)/);
    const taxable = subTotalM ? stripCommas(subTotalM[1]) : null;
    const qty = qtyM ? stripCommas(qtyM[1]) : null;
    if (taxable && qty) {
      out.qty = qty;
      out.taxableFromBill = taxable;
      out.rate = round2(taxable / qty);
      out.warnings.push(
        'Qty/rate recovered from the Sub Total / item-table total, not the line-item row - verify against the PDF.'
      );
    }
  }

  return out;
}

function extractHonestfalcon(text) {
  const out = { warnings: [] };

  let m = text.match(/Invoice\s+No\.\s*e-Way\s+Bill\s+No\.\s*\n\s*(\S+)/i);
  out.invoiceNo = m ? m[1].trim() : null;
  if (!out.invoiceNo) {
    m = text.match(/Invoice\s+No\.[^\n]*\n\s*(\S+)/i);
    out.invoiceNo = m ? m[1].trim() : null;
  }

  m = text.match(/\bDated\b\s*\n?\s*(\d{1,2}[-\/][A-Za-z]{3,9}[-\/]\d{2,4})/i);
  out.invoiceDateRaw = m ? m[1].trim() : null;

  m = text.match(/Motor\s+Vehicle\s+No\.?\s*\n\s*([A-Z]{2}[A-Z0-9]{4,12})/i);
  out.vehicleNo = m ? m[1].trim().toUpperCase() : null;

  // Total line: confirmed from a real bill to read
  // "Total <currency-glyph> <amount> <qty> MTS" - amount BEFORE qty, not
  // after. The currency glyph is often mis-decoded (seen as "i" / "ī"),
  // so match any short run of non-digits between "Total" and the amount.
  m = text.match(/\bTotal\b[^\d]{0,8}([\d,]+\.\d{2})\s+([\d.]+)\s+MTS/i);
  const totalAmountFromTotalLine = m ? stripCommas(m[1]) : null;
  const totalQty = m ? stripCommas(m[2]) : null;
  out.printedTotal = totalAmountFromTotalLine;

  // Primary: confirmed from a real bill that this layout's line-item row
  // reads "IMPORTED COAL <amount> MTS <rate> <qty> MTS <hsn>" - the
  // numeric columns come out in the REVERSE of their visual left-to-right
  // order (amount, then rate, then qty, then HSN).
  m = text.match(/IMPORTED\s+COAL\s+([\d,]+\.\d{2})\s+MTS\s+([\d,]+\.\d{2})\s+([\d.]+)\s+MTS\s+\d{4,8}/i);
  if (m) {
    out.taxableFromBill = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
    out.qty = stripCommas(m[3]);
  } else {
    // Fallback: some exports may print this row in the "expected" left-to-
    // right order instead - try that shape too before giving up on it.
    m = text.match(/IMPORTED\s+COAL\s+\d{4,8}\s+([\d.]+)\s+MTS\s+([\d.,]+)\s+MTS\s+([\d.,]+)/i);
    if (m) {
      out.qty = stripCommas(m[1]);
      out.rate = stripCommas(m[2]);
      out.taxableFromBill = stripCommas(m[3]);
    }
  }

  // Second fallback: pull the taxable value from the HSN/Taxable/CGST/SGST
  // summary grid instead. Also confirmed reversed on a real bill - reads
  // "<hsn> <totalTax> <sgstAmt> 9% <cgstAmt> 9% <taxable>", taxable last.
  if (!out.qty || !out.rate) {
    const grid = text.match(
      /\d{4,8}\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+9%\s+[\d,]+\.\d{2}\s+9%\s+([\d,]+\.\d{2})/
    );
    const taxable = grid ? stripCommas(grid[1]) : null;
    if (totalQty && taxable) {
      out.qty = totalQty;
      out.taxableFromBill = taxable;
      out.rate = round2(taxable / totalQty);
      out.warnings.push(
        'Qty/rate recovered from the tax summary grid, not the line-item row - verify against the PDF.'
      );
    }
  }

  return out;
}

function extractGeneric(text) {
  const out = { warnings: ['Unknown supplier - fields extracted with generic patterns, verify carefully.'] };

  let m = text.match(/Invoice\s*No\.?:?\s*\n?\s*([A-Za-z0-9\/\-]+)/i);
  out.invoiceNo = m ? m[1].trim() : null;

  m = text.match(/\bDated\b\s*\n?\s*(\d{1,2}[-\/][A-Za-z0-9]{2,9}[-\/]\d{2,4})/i);
  out.invoiceDateRaw = m ? m[1].trim() : null;

  m = text.match(/(?:Motor\s*)?Vehicle\s*No\.?[^\n]*\n\s*([A-Z]{2}[A-Z0-9]{4,12})/i);
  out.vehicleNo = m ? m[1].trim().toUpperCase() : null;

  m = text.match(/([\d.]{2,10})\s+MTS?\b[^\d]{0,15}([\d.,]{3,15})/i);
  if (m) {
    out.qty = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
  }

  return out;
}

// ---- Tax computation, matched to Tally's own arithmetic ---------------
// Verified against the real posted voucher (49.050 MTS @ 10200) and all
// four Agarwal sample bills: CGST/SGST are 9% of taxable, TCS is 2% of
// (taxable + CGST + SGST) - not 2% of taxable - and round-off closes the
// gap to the nearest rupee.
function computeTax(qty, rate) {
  const taxable = round2(qty * rate);
  const cgst = round2(taxable * 0.09);
  const sgst = round2(taxable * 0.09);
  const tcs = round2((taxable + cgst + sgst) * 0.02);
  const preRound = taxable + cgst + sgst + tcs;
  const total = Math.round(preRound);
  const roundOff = round2(total - preRound);
  return { taxable, cgst, sgst, tcs, roundOff, total };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---- pdf.js glue --------------------------------------------------------

async function pdfFileToText(file) {
  const buf = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: buf });
  const pdf = await loadingTask.promise;
  let fullText = '';
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    let lastY = null;
    for (const item of content.items) {
      const y = item.transform[5];
      if (lastY !== null && Math.abs(y - lastY) > 2) {
        fullText += '\n';
      }
      fullText += item.str + ' ';
      lastY = y;
    }
    fullText += '\n';
  }
  return fullText;
}

async function extractBillFromFile(file) {
  const text = await pdfFileToText(file);
  const supplier = detectSupplier(text);

  let fields;
  switch (supplier.template) {
    case 'agarwal':
      fields = extractAgarwal(text);
      break;
    case 'mpfuel':
      fields = extractMpFuel(text);
      break;
    case 'honestfalcon':
      fields = extractHonestfalcon(text);
      break;
    default:
      fields = extractGeneric(text);
  }

  const invoiceDateIso = parseBillDate(fields.invoiceDateRaw);
  const qty = fields.qty || null;
  const rate = fields.rate || null;
  const computed = qty && rate ? computeTax(qty, rate) : null;

  const warnings = [...(fields.warnings || [])];
  if (!supplier.gstin) warnings.push('Supplier GSTIN could not be determined - pick a ledger manually.');
  if (supplier.ambiguousGstins && supplier.ambiguousGstins.length > 1) {
    warnings.push(`Multiple unrecognised GSTINs found (${supplier.ambiguousGstins.join(', ')}) - confirm supplier.`);
  }
  if (!fields.invoiceNo) warnings.push('Invoice number not found.');
  if (!invoiceDateIso) warnings.push('Invoice date not found or unparsable.');
  if (!fields.vehicleNo) warnings.push('Vehicle number not found - narration will be blank.');
  if (!qty || !rate) warnings.push('Quantity/rate not found - cannot compute GST.');

  return {
    fileName: file.name,
    supplierGSTIN: supplier.gstin,
    supplierLabel: supplier.label,
    template: supplier.template,
    invoiceNo: fields.invoiceNo || '',
    invoiceDate: invoiceDateIso || '',
    invoiceDateTally: isoToTally(invoiceDateIso),
    vehicleNo: fields.vehicleNo || '',
    qty: qty,
    rate: rate,
    taxableFromBill: fields.taxableFromBill || null,
    printedTotal: fields.printedTotal || null,
    computed,
    warnings,
    rawText: text,
  };
}

window.BillExtract = {
  extractBillFromFile,
  computeTax,
  parseBillDate,
  isoToTally,
  KNOWN_SUPPLIERS,
  SELF_GSTIN,
};
