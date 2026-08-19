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
  '24AAGCV1903N1Z8': { label: 'VNU Coal Private Limited', template: 'vnucoal' },
};

// Full 15-char shape (state code, 10-char PAN, entity code, literal "Z",
// checksum) is specific enough on its own - no \b anchors. Anchors were
// tried first but broke on real bills: after stripping whitespace to
// rejoin a token pdf.js split apart, a GSTIN sitting right before the next
// label (e.g. "...N1Z6StateName...", no punctuation between them) has no
// word-boundary at its own end, since both the last GSTIN char and the
// first letter of the next label are word characters - so the anchored
// version silently found zero GSTINs on such bills. Confirmed against the
// JAI SAI COAL TRADERS bill (GSTIN 24AAECJ7824N1Z6, immediately followed
// by "State Name" with no separator once whitespace is stripped).
const GSTIN_SHAPE_RE = /\d{2}[A-Z]{5}\d{4}[A-Z][A-Z0-9]Z[A-Z0-9]/g;

function stripCommas(numStr) {
  if (numStr == null) return NaN;
  return parseFloat(String(numStr).replace(/,/g, '').trim());
}

// pdf.js can split even a single visually-contiguous token (like a GSTIN)
// across multiple text items, which inserts whitespace into it when the
// items are joined. Matching against a whitespace-stripped copy sidesteps
// that regardless of where the splits land.
function findAllGstins(text) {
  const compact = text.replace(/\s+/g, '');
  const found = new Set();
  GSTIN_SHAPE_RE.lastIndex = 0;
  let m;
  while ((m = GSTIN_SHAPE_RE.exec(compact))) {
    found.add(m[0]);
  }
  return Array.from(found);
}

function detectSupplier(text) {
  const compact = text.replace(/\s+/g, '');
  for (const gstin of Object.keys(KNOWN_SUPPLIERS)) {
    if (compact.includes(gstin)) {
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

// UNVERIFIED against live pdf.js output - built from a single sample bill's
// visual layout only, not a confirmed raw-text dump like the other three
// templates. This layout is visually similar to Honestfalcon's (same IRN/
// e-Invoice header style), and Honestfalcon's line-item row turned out to
// print its columns in reverse order in the real pdf.js text - so both the
// "as printed" and the Honestfalcon-reversed order are tried here. Update
// this once a real raw-text sample confirms which one actually applies.
function extractVnuCoal(text) {
  const out = { warnings: ['VNU Coal template is unverified against live output - double-check qty/rate/total.'] };

  let m = text.match(/Invoice\s+No\.\s*e-Way\s+Bill\s+No\.\s*\n\s*(\S+)/i);
  out.invoiceNo = m ? m[1].trim() : null;
  if (!out.invoiceNo) {
    m = text.match(/Invoice\s+No\.[^\n]*\n\s*(\S+)/i);
    out.invoiceNo = m ? m[1].trim() : null;
  }

  m = text.match(/\bDated\b\s*\n?\s*(\d{1,2}[-\/][A-Za-z]{3,9}[-\/]\d{2,4})/i);
  out.invoiceDateRaw = m ? m[1].trim() : null;

  // No "Motor Vehicle No." label on this layout - the vehicle number sits
  // under "Dispatched through" instead.
  m = text.match(/Dispatched\s+through\s*\n\s*([A-Z]{2}[A-Z0-9]{4,12})/i);
  out.vehicleNo = m ? m[1].trim().toUpperCase() : null;

  // Total line: printed as "Total <qty> MT <amount>", but try the
  // Honestfalcon-confirmed reversed order too. Whichever matches, the
  // smaller number is qty (tens of MT) and the larger is the rupee total.
  m =
    text.match(/\bTotal\b[^\d]{0,8}([\d,]+\.\d{2})\s+([\d.]+)\s+MT\b/i) ||
    text.match(/\bTotal\b\s+([\d.]+)\s+MT[^\d]{0,10}([\d,]+\.\d{2})/i);
  let totalQty = null;
  if (m) {
    const a = stripCommas(m[1]);
    const b = stripCommas(m[2]);
    if (a < b) {
      totalQty = a;
      out.printedTotal = b;
    } else {
      totalQty = b;
      out.printedTotal = a;
    }
  }

  // Line-item row: "as printed" order first, then Honestfalcon's
  // confirmed-reversed order (amount, rate, qty, hsn).
  m = text.match(/US\s+Steam\s+Coal\s+\d{4,8}\s+([\d.]+)\s+MT\s+([\d.,]+)\s+MT\s+([\d.,]+)/i);
  if (m) {
    out.qty = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
    out.taxableFromBill = stripCommas(m[3]);
  } else {
    m = text.match(/US\s+Steam\s+Coal\s+([\d.,]+)\s+MT\s+([\d.,]+)\s+([\d.]+)\s+MT\s+\d{4,8}/i);
    if (m) {
      out.taxableFromBill = stripCommas(m[1]);
      out.rate = stripCommas(m[2]);
      out.qty = stripCommas(m[3]);
    }
  }

  // Fallback: HSN/Taxable/CGST/SGST summary grid (both column orders) +
  // the Total line's qty - the same robust technique that rescued
  // Honestfalcon and MP Fuel when their line-item row didn't parse.
  if (!out.qty || !out.rate) {
    const gridForward = text.match(/\d{4,8}\s+([\d,]+\.\d{2})\s+9%\s+([\d,]+\.\d{2})\s+9%\s+([\d,]+\.\d{2})/);
    const gridReversed = text.match(/\d{4,8}\s+[\d,]+\.\d{2}\s+[\d,]+\.\d{2}\s+9%\s+[\d,]+\.\d{2}\s+9%\s+([\d,]+\.\d{2})/);
    const taxable = gridForward ? stripCommas(gridForward[1]) : gridReversed ? stripCommas(gridReversed[1]) : null;
    if (totalQty && taxable) {
      out.qty = totalQty;
      out.taxableFromBill = taxable;
      out.rate = round2(taxable / totalQty);
      out.warnings.push('Qty/rate recovered from the tax summary grid, not the line-item row - verify against the PDF.');
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

// Automatic, backend-driven fallback for a genuinely unrecognized supplier
// (detectSupplier found no known GSTIN). Sends the already-extracted text
// to the bridge's /api/ai-profile endpoint (Groq, server-side key). Never
// throws: if the endpoint is disabled (no key configured), unreachable, or
// returns something unusable, the caller just keeps extractGeneric's
// result - behaviour is unchanged whenever AI profiling isn't available.
async function tryAiProfile(text, fileName) {
  try {
    const resp = await fetch('/api/ai-profile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, fileName }),
    });
    // 503 means the feature is simply not configured (no Groq key in
    // .env) - that's not a failure worth flagging, just "not available".
    if (resp.status === 503) return { ok: false, reason: 'not_configured' };
    if (!resp.ok) return { ok: false, reason: 'error' };
    const data = await resp.json();
    if (!data || !data.fields) return { ok: false, reason: 'error' };
    return { ok: true, fields: data.fields };
  } catch {
    return { ok: false, reason: 'error' };
  }
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

// ---- OCR field extraction (scanned/image-only PDFs) ---------------------
// Tesseract reads pages in visual top-to-bottom/left-to-right order, which
// sidesteps pdf.js's content-stream reordering problems, but introduces
// character-level noise instead (misread digits, stray table-border
// characters). Patterns here were built and verified against a real OCR
// transcript (76% confidence) of an actual scanned bill - not guessed from
// a rendered preview - and every recovered figure reproduced the bill's
// printed CGST/SGST/TCS/round-off/total exactly via computeTax().
function extractOcr(text) {
  const out = { warnings: [] };

  // Invoice No + date: a slash-shaped invoice number immediately followed
  // by a date on the same line. Requiring the slash avoids latching onto
  // an unrelated digit run (Ack No./IRN) the way a bare \d+ would.
  let m = text.match(/(\d{3,8}\/\d{1,8}\/?)[^\n\d]{0,10}?(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i);
  if (m) {
    out.invoiceNo = m[1].trim();
    out.invoiceDateRaw = m[2];
  } else {
    m = text.match(/Invoice\s*No\.?[^\n]{0,40}?\n?\s*(\S{3,20})/i);
    out.invoiceNo = m ? m[1].replace(/[|\[\]]/g, '') : null;
    const dateMatches = [...text.matchAll(/(\d{1,2}-[A-Za-z]{3,9}-\d{2,4})/g)];
    out.invoiceDateRaw = null;
    for (const dm of dateMatches) {
      const context = text.slice(Math.max(0, dm.index - 20), dm.index);
      if (!/Ack\s*Date/i.test(context)) {
        out.invoiceDateRaw = dm[1];
        break;
      }
    }
    if (!out.invoiceDateRaw && dateMatches.length) out.invoiceDateRaw = dateMatches[0][1];
  }

  // Vehicle: Indian plate format scanned standalone, since the nearby
  // label ("Dispatched through"/"Motor Vehicle No.") is often unreadable
  // in a noisy scan. Exactly 4 trailing digits (not 3-4) is required to
  // avoid matching unrelated reference codes shaped like a plate.
  m = text.match(/\b([A-Z]{2}\d{1,2}[A-Z]{1,2}\d{4})\b/);
  out.vehicleNo = m ? m[1].toUpperCase() : null;

  // Qty/Rate: "<qty> MT ... <rate> MT" anywhere, tolerant of stray
  // [ ] | characters OCR picks up from table borders - confirmed two real
  // OCR runs of the same bill put a stray character in different spots
  // (one used "|" before the second MT, another used "]"), so every
  // junction accepts any of them rather than one hardcoded choice.
  m = text.match(/([\d.]{2,10})[\[\]\|\s]*MT[\[\]\|\s]*([\d.,]{4,15})[\[\]\|\s]*MT/i);
  if (m) {
    out.qty = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
  }

  return out;
}

// ---- pdf.js glue --------------------------------------------------------

// diag lets a caller distinguish "found text but my regexes are wrong"
// from "pdf.js found zero text items" (e.g. a scanned/rasterized PDF with
// no embedded text layer at all, which no amount of regex tuning fixes).
// Returns one text string per page (not one joined blob) so a caller can
// tell where page boundaries are - needed to split a file that bundles
// more than one bill.
async function pdfFileToPages(file) {
  const diag = { numPages: null, itemsPerPage: [], totalItems: 0, error: null };
  try {
    const buf = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: buf });
    const pdf = await loadingTask.promise;
    diag.numPages = pdf.numPages;
    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      diag.itemsPerPage.push(content.items.length);
      diag.totalItems += content.items.length;
      let pageText = '';
      let lastY = null;
      for (const item of content.items) {
        const y = item.transform[5];
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          pageText += '\n';
        }
        pageText += item.str + ' ';
        lastY = y;
      }
      pages.push(pageText);
    }
    return { pages, diag };
  } catch (e) {
    diag.error = e && e.message ? e.message : String(e);
    return { pages: [], diag };
  }
}

// Only called when pdfFileToPages finds zero text items. Renders every
// page to a canvas at 3x scale (higher DPI measurably improves OCR
// accuracy) and runs each through the locally-vendored Tesseract engine -
// no network calls, same "everything local" rule as pdf.js itself. Pages
// run sequentially (each OCR pass is already a real cost - render + wasm
// recognition), and one page failing doesn't lose the rest of a scanned
// multi-page/multi-bill file.
async function ocrPdfPages(file, onProgress) {
  const diag = { numPages: null, perPage: [], error: null };
  try {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    diag.numPages = pdf.numPages;
    const pages = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      if (onProgress) onProgress('ocr-page', { page: pageNum, total: pdf.numPages });
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 3.0 });
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;
      try {
        const result = await Tesseract.recognize(canvas, 'eng', {
          workerPath: 'vendor/worker.min.js',
          corePath: 'vendor/tesseract-core/tesseract-core.wasm.js',
          langPath: 'vendor/',
          gzip: true,
        });
        pages.push(result.data.text);
        diag.perPage.push({ confidence: result.data.confidence, error: null });
      } catch (pageErr) {
        pages.push('');
        diag.perPage.push({ confidence: null, error: pageErr && pageErr.message ? pageErr.message : String(pageErr) });
      }
    }
    return { pages, diag };
  } catch (e) {
    diag.error = e && e.message ? e.message : String(e);
    return { pages: [], diag };
  }
}

// Used only to decide where one bill ends and the next begins across a
// file's pages - not a final field value (the per-supplier templates
// still extract that, more precisely, from each group's own text once
// grouping is done). A single generic pattern isn't reliable enough for
// this: pdf.js reorders each supplier's layout differently (see the
// per-extractor comments below), so a naive "Invoice No" + next-token
// match ends up capturing the wrong thing entirely on some layouts - e.g.
// it grabbed the literal word "e-Way" on Honestfalcon/VNU Coal bills
// (whose real label reads "Invoice No.  e-Way Bill No." on one line, with
// values only appearing on the *next* line) and the word "Invoice" itself
// on MP Fuel bills (whose layout prints every label, then every colon,
// then every value, in three separate blocks) - confirmed against real
// captured text before shipping. So this reuses each known supplier's own
// already-proven invoiceNo pattern once its GSTIN is detected, falling
// back to the generic pattern (same one extractGeneric uses) otherwise.
// Normalized (whitespace stripped, uppercased) so a trivial OCR/
// formatting difference between two pages of the same bill doesn't
// register as a different number. OCR'd pages need their own branch, same
// reason extractGroupFields doesn't run the per-supplier switch on OCR
// text either: Tesseract reads in visual order with character-level
// noise, not pdf.js's per-generator content-stream order, so the "clean
// text" patterns below can latch onto the wrong thing entirely (confirmed
// on a real VNU Coal scan, where the e-Way-Bill-label pattern matched an
// OCR-garbled fragment of the supplier's own name on the following line).
function probeInvoiceNoOnPage(pageText, isOcr) {
  if (isOcr) {
    const m =
      pageText.match(/(\d{3,8}\/\d{1,8}\/?)[^\n\d]{0,10}?(\d{1,2}-[A-Za-z]{3}-\d{2,4})/i) ||
      pageText.match(/Invoice\s*No\.?[^\n]{0,40}?\n?\s*(\S{3,20})/i);
    if (!m) return null;
    return m[1].replace(/[|\[\]]/g, '').replace(/\s+/g, '').toUpperCase();
  }

  const supplier = detectSupplier(pageText);
  let m;
  switch (supplier.template) {
    case 'agarwal':
      m = pageText.match(/Invoice\s+No:\s*\n?\s*([A-Za-z0-9\/\-]+)/i);
      break;
    case 'mpfuel':
      m =
        pageText.match(
          /Invoice\s+No\.\s*\n\s*Invoice\s+Date\s*\n\s*Delivery\s+Ex\s*\n\s*:\s*\n\s*:\s*\n\s*:\s*\n\s*([A-Za-z0-9\/\-]+)/i
        ) || pageText.match(/Invoice\s+No\.[^\n]*\n[\s\S]{0,60}?:\s*\n\s*([A-Za-z0-9\/\-]+)/i);
      break;
    case 'honestfalcon':
    case 'vnucoal':
      m =
        pageText.match(/Invoice\s+No\.\s*e-Way\s+Bill\s+No\.\s*\n\s*(\S+)/i) ||
        pageText.match(/Invoice\s+No\.[^\n]*\n\s*(\S+)/i);
      break;
    default:
      m = pageText.match(/Invoice\s*No\.?:?\s*\n?\s*([A-Za-z0-9\/\-]+)/i);
  }
  if (!m) return null;
  return m[1].replace(/[|\[\]]/g, '').replace(/\s+/g, '').toUpperCase();
}

// Splits a file's pages into one group per distinct invoice number found.
// Page 1 always starts the first group, whatever it contains (matches the
// existing single-bill fallback for when no number is found anywhere in
// the file). Any later page whose probed number differs from the
// currently open group starts a new one; a page with no number, or the
// same number repeated (e.g. a header reprinted on a continuation page),
// attaches to the group already open - so a page 2 of pure tax-summary
// tables joins the bill above it rather than becoming its own row, per
// the confirmed default. A leading page with no detected number (e.g. an
// odd cover page) becomes its own small first group rather than being
// guessed forward onto a later bill - it'll surface with the same
// missing-field warnings any bill with absent fields already gets today,
// which is safer than silently merging two unrelated pages together.
function groupPagesByInvoiceNo(pages, isOcr) {
  const groups = [];
  let currentProbe = null;
  for (let i = 0; i < pages.length; i++) {
    const probe = probeInvoiceNoOnPage(pages[i], isOcr);
    const group = groups[groups.length - 1];
    if (group && (probe === null || probe === currentProbe)) {
      group.endPage = i + 1;
      group.text += '\n' + pages[i];
    } else {
      groups.push({ startPage: i + 1, endPage: i + 1, text: pages[i] });
      currentProbe = probe;
    }
  }
  if (groups.length === 0) groups.push({ startPage: 1, endPage: 1, text: '' });
  return groups;
}

// Step 1 of extraction: get a file down to per-bill text groups. Fast and
// fully local (no AI) - the caller runs this first so it can create the
// right number of rows before the slower per-group field extraction (and
// possible AI calls) begin. onProgress here only ever reports OCR
// page-by-page progress ('ocr-page'), since AI hasn't been reached yet.
async function splitFileIntoGroups(file, onProgress) {
  let { pages, diag } = await pdfFileToPages(file);
  let extractionMethod = 'text';

  if (diag.error) {
    diag.ocrWarnings = [`PDF failed to load: ${diag.error}`];
    return { groups: [{ startPage: 1, endPage: 1, text: '' }], diag, extractionMethod };
  }

  if (diag.totalItems === 0) {
    // No embedded text at all - almost certainly a scanned/rasterized
    // file, which no regex fix can address. Fall back to OCR, page by
    // page, rather than returning an empty row.
    const ocrResult = await ocrPdfPages(file, onProgress);
    extractionMethod = 'ocr';
    diag = { ...diag, ocr: ocrResult.diag };
    pages = ocrResult.pages;

    const confidences = ocrResult.diag.perPage.map((p) => p.confidence).filter((c) => c != null);
    const anyText = pages.some((p) => p && p.trim());
    if (ocrResult.diag.error) {
      diag.ocrWarnings = [
        `No embedded text found (scanned/image PDF), and OCR failed: ${ocrResult.diag.error}. Every field needs manual entry.`,
      ];
    } else if (!anyText) {
      diag.ocrWarnings = ['No embedded text found (scanned/image PDF), and OCR found nothing either. Every field needs manual entry.'];
    } else {
      const avgConfidence = confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : null;
      diag.ocrWarnings = [
        `Extracted via OCR (scanned image, no embedded text in the PDF, confidence ${
          avgConfidence != null ? avgConfidence.toFixed(0) + '%' : 'unknown'
        }) - accuracy is lower than digital text. Verify every field carefully before sending.`,
      ];
    }
  }

  const groups = groupPagesByInvoiceNo(pages.length ? pages : [''], extractionMethod === 'ocr');
  return { groups, diag, extractionMethod };
}

// Step 2 of extraction: given one bill's already-grouped text, find its
// fields. This is the part of the old single-shot extractBillFromFile
// that runs once per bill - unchanged logic, it just no longer loads the
// PDF itself. fileDiag is the whole file's diag (shared across every
// group split from the same file): it carries the OCR-quality/load-error
// warnings computed once in splitFileIntoGroups, plus (per call) this
// group's own page range for traceability.
async function extractGroupFields(text, fileLabel, extractionMethod, fileDiag, onProgress) {
  let aiStatus;
  const warnings = [...(fileDiag.ocrWarnings || [])];

  const supplier = detectSupplier(text);

  let fields;
  if (extractionMethod === 'ocr') {
    // OCR reads pages in visual order regardless of supplier, which
    // sidesteps the per-generator pdf.js reordering the other templates
    // work around - one generic OCR-tuned extractor covers all of them.
    fields = extractOcr(text);
  } else {
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
      case 'vnucoal':
        fields = extractVnuCoal(text);
        break;
      default:
        fields = extractGeneric(text);
    }

    if (supplier.template === 'generic') {
      if (onProgress) onProgress('ai-pending');
      const aiResult = await tryAiProfile(text, fileLabel);
      if (aiResult.ok) {
        const aiFields = aiResult.fields;
        extractionMethod = 'ai';
        if (aiFields.invoiceNo != null) fields.invoiceNo = aiFields.invoiceNo;
        if (aiFields.invoiceDateRaw != null) fields.invoiceDateRaw = aiFields.invoiceDateRaw;
        if (aiFields.vehicleNo != null) fields.vehicleNo = aiFields.vehicleNo;
        if (aiFields.qty != null) fields.qty = aiFields.qty;
        if (aiFields.rate != null) fields.rate = aiFields.rate;
        // Some layouts print our own name/GSTIN prominently near the top
        // (as the buyer) before the real supplier appears further down -
        // seen for real on a Taranjot Energy bill, where the AI echoed our
        // own GSTIN back as if it were the supplier's. Never accept that.
        if (!supplier.gstin && aiFields.supplierGSTIN && aiFields.supplierGSTIN !== SELF_GSTIN) {
          supplier.gstin = aiFields.supplierGSTIN;
        }
        if (!supplier.label && aiFields.supplierName && !/DELTA\s*GLOBAL/i.test(aiFields.supplierName)) {
          supplier.label = aiFields.supplierName;
        }
        fields.warnings = [
          ...(fields.warnings || []),
          'Fields pre-filled with AI assistance (unrecognized supplier layout) - verify every field carefully.',
        ];
        aiStatus = 'ok';
        if (onProgress) onProgress('ai-ok');
      } else if (aiResult.reason === 'error') {
        fields.warnings = [
          ...(fields.warnings || []),
          'AI-assisted extraction was attempted but failed - falling back to generic pattern matching.',
        ];
        aiStatus = 'failed';
        if (onProgress) onProgress('ai-failed');
      } else {
        if (onProgress) onProgress('ai-skip');
      }
    }
  }

  const invoiceDateIso = parseBillDate(fields.invoiceDateRaw);
  const qty = fields.qty || null;
  const rate = fields.rate || null;
  const computed = qty && rate ? computeTax(qty, rate) : null;

  warnings.push(...(fields.warnings || []));
  if (extractionMethod !== 'ocr' && !fileDiag.error && fileDiag.totalItems !== 0) {
    if (!supplier.gstin) warnings.push('Supplier GSTIN could not be determined - pick a ledger manually.');
    if (supplier.ambiguousGstins && supplier.ambiguousGstins.length > 1) {
      warnings.push(`Multiple unrecognised GSTINs found (${supplier.ambiguousGstins.join(', ')}) - confirm supplier.`);
    }
  }
  if (!fields.invoiceNo) warnings.push('Invoice number not found.');
  if (!invoiceDateIso) warnings.push('Invoice date not found or unparsable.');
  if (!fields.vehicleNo) warnings.push('Vehicle number not found - narration will be blank.');
  if (!qty || !rate) warnings.push('Quantity/rate not found - cannot compute GST.');

  return {
    fileName: fileLabel,
    supplierGSTIN: supplier.gstin,
    supplierLabel: supplier.label,
    template: supplier.template,
    extractionMethod,
    aiStatus,
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
    diag: fileDiag,
  };
}

window.BillExtract = {
  splitFileIntoGroups,
  extractGroupFields,
  computeTax,
  parseBillDate,
  isoToTally,
  KNOWN_SUPPLIERS,
  SELF_GSTIN,
};
