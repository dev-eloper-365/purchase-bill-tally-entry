const fs = require('fs');
const text = fs.readFileSync('ocr_sample.txt', 'utf8');

function stripCommas(numStr) {
  if (numStr == null) return NaN;
  return parseFloat(String(numStr).replace(/,/g, '').trim());
}

function extractOcr(text) {
  const out = { warnings: [] };

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
      if (!/Ack\s*Date/i.test(context)) { out.invoiceDateRaw = dm[1]; break; }
    }
    if (!out.invoiceDateRaw && dateMatches.length) out.invoiceDateRaw = dateMatches[0][1];
  }

  m = text.match(/\b([A-Z]{2}\d{1,2}[A-Z]{1,2}\d{4})\b/);
  out.vehicleNo = m ? m[1].toUpperCase() : null;

  m = text.match(/([\d.]{2,10})\s*\|?\s*MT\s*[\[\|]?\s*([\d.,]{4,15})\s*\|?\s*MT/i);
  if (m) {
    out.qty = stripCommas(m[1]);
    out.rate = stripCommas(m[2]);
  }

  return out;
}

const result = extractOcr(text);
console.log(JSON.stringify(result, null, 2));
console.log('Expected: invoiceNo=2721/3032/, date=17-Aug-26, vehicle=GJ39TA6198, qty=51.44, rate=14075');
