// Standalone Node harness that runs the exact same pdf.js text-extraction
// logic as web/extract.js's pdfFileToText(), so a bill's real raw text can
// be inspected here directly instead of needing a browser round-trip for
// every diagnostic check.
//
// Usage: node test-extract.js "path\to\bill.pdf"

const fs = require('fs');
const path = require('path');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');

async function pdfFileToText(filePath) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const diag = { numPages: null, itemsPerPage: [], totalItems: 0, error: null };
  try {
    const loadingTask = pdfjsLib.getDocument({ data });
    const pdf = await loadingTask.promise;
    diag.numPages = pdf.numPages;
    let fullText = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      diag.itemsPerPage.push(content.items.length);
      diag.totalItems += content.items.length;
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
    return { text: fullText, diag };
  } catch (e) {
    diag.error = e && e.message ? e.message : String(e);
    return { text: '', diag };
  }
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-extract.js "path\\to\\bill.pdf"');
    process.exit(1);
  }
  const resolved = path.resolve(filePath);
  const { text, diag } = await pdfFileToText(resolved);
  console.log('=== DIAG ===');
  console.log(JSON.stringify(diag, null, 2));
  console.log('=== TEXT ===');
  console.log(text);
}

main();
