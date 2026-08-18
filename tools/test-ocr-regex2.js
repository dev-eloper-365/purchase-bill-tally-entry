const fs = require('fs');

function stripCommas(numStr) {
  return parseFloat(String(numStr).replace(/,/g, '').trim());
}

// More tolerant of stray table-border characters ([ ] |) in any position
// between the numbers and the "MT" markers, not just a pipe before the
// second one - different OCR runs on the same layout produced different
// stray characters at that junction.
const re = /([\d.]{2,10})[\[\]\|\s]*MT[\[\]\|\s]*([\d.,]{4,15})[\[\]\|\s]*MT/i;

const sample1 = fs.readFileSync('ocr_sample.txt', 'utf8'); // pipe variant: "14,075.00| MT"
const sample2 = fs.readFileSync('ocr_sample2.txt', 'utf8'); // bracket variant: "14,075.00] MT"

for (const [name, text] of [['sample1 (pipe)', sample1], ['sample2 (bracket)', sample2]]) {
  const m = text.match(re);
  if (m) {
    console.log(name, '-> qty=' + stripCommas(m[1]), 'rate=' + stripCommas(m[2]));
  } else {
    console.log(name, '-> NO MATCH');
  }
}
