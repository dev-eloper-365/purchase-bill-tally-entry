// Renders a PDF page to a bitmap (via pdf.js + node-canvas) and runs
// Tesseract OCR against it, so OCR accuracy can be checked here directly
// before wiring the fallback into the actual browser app.
//
// Usage: node test-ocr.js "path\to\bill.pdf"

const fs = require('fs');
const path = require('path');
const { createCanvas } = require('canvas');
const pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js');
const Tesseract = require('tesseract.js');

async function renderPageToPng(filePath, pageNum, scale) {
  const data = new Uint8Array(fs.readFileSync(filePath));
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas.toBuffer('image/png');
}

async function main() {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('Usage: node test-ocr.js "path\\to\\bill.pdf"');
    process.exit(1);
  }
  const resolved = path.resolve(filePath);

  console.log('Rendering page 1 to PNG at scale 3x...');
  const pngBuffer = await renderPageToPng(resolved, 1, 3.0);
  const outPng = path.join(path.dirname(resolved), 'ocr-test-page1.png');
  fs.writeFileSync(outPng, pngBuffer);
  console.log('Saved render to', outPng, `(${pngBuffer.length} bytes)`);

  console.log('Running OCR (this can take a while on first run - downloads eng traineddata)...');
  const start = Date.now();
  const result = await Tesseract.recognize(pngBuffer, 'eng', {
    logger: (m) => {
      if (m.status && m.progress != null) process.stdout.write(`\r${m.status}: ${(m.progress * 100).toFixed(0)}%   `);
    },
  });
  console.log(`\nOCR took ${((Date.now() - start) / 1000).toFixed(1)}s, confidence=${result.data.confidence}`);
  console.log('=== OCR TEXT ===');
  console.log(result.data.text);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
