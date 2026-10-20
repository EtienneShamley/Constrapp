// Regenerates tests/unit/fixtures/quant-two-page.pdf — the local PDF fixture
// the Quant™ unit suite loads through PDF.js (no Storage, no CORS, no canvas)
// and the sheet the `npm run test:quant` emulator launcher seeds for manual
// acceptance. Every drawn dimension is KNOWN, so a calibration and a measurement
// can be checked against an expected quantity.
//
//   node tests/unit/fixtures/make-quant-fixture.mjs tests/unit/fixtures/quant-two-page.pdf
//
// Page 1 — ordinary portrait, MediaBox 612×792 (canonical 612×792, rotation 0).
//   A 400 × 300 pt rectangle with its lower-left corner at (100, 100), i.e.
//   canonical corners (100, 392)–(500, 692) [y runs down in canonical space].
//   Labelled "4000 mm" along the bottom edge and "3000 mm" up the left edge.
//   ⇒ calibrate the 400 pt bottom edge as 4000 mm; then the rectangle measures
//      perimeter 14 m, area 12 m², and the diagonal 5 m.
// Page 2 — landscape MediaBox 842×595 with /Rotate 90 AND CropBox [50 50 800 550]
//   (canonical 500×750, rotation 90 — PDF.js reports a 500×750 scale-1 viewport).
//   A 600 × 400 pt rectangle in user space from (100, 100) to (700, 500), which
//   the rotation turns into a 400-wide × 600-tall rectangle on screen with
//   canonical corners (50, 50)–(450, 650). Labelled "6000 mm" along the long
//   side and "4000 mm" along the short side.
//   ⇒ calibrate the 400 pt (short, now horizontal) edge as 4000 mm; then the
//      rectangle measures perimeter 20 m and area 24 m².
// The xref offsets are computed, so PDF.js never has to reconstruct the file.
import { writeFileSync } from 'node:fs'

const objs = []
objs.push('<< /Type /Catalog /Pages 2 0 R >>')
objs.push('<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>')

// Page 1 content: rectangle, tick marks, labels.
const c1 = [
  '1 w 0 0 0 RG',
  '100 100 400 300 re S',
  // dimension ticks on the bottom edge and left edge
  '100 85 m 100 95 l S', '500 85 m 500 95 l S', '100 90 m 500 90 l S',
  '85 100 m 95 100 l S', '85 400 m 95 400 l S', '90 100 m 90 400 l S',
  'BT /F1 14 Tf 270 70 Td (4000 mm) Tj ET',
  'BT /F1 14 Tf 0 1 -1 0 70 215 Tm (3000 mm) Tj ET',
  'BT /F1 11 Tf 100 410 Td (Quant acceptance sheet 1 - rectangle 400 x 300 pt = 4000 x 3000 mm) Tj ET',
].join('\n')
objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>')
objs.push(`<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`)

// Page 2 content (user space, before the page's /Rotate 90 is applied).
const c2 = [
  '1 w 0 0 0 RG',
  '100 100 600 400 re S',
  '100 85 m 100 95 l S', '700 85 m 700 95 l S', '100 90 m 700 90 l S',
  '85 100 m 95 100 l S', '85 500 m 95 500 l S', '90 100 m 90 500 l S',
  'BT /F1 14 Tf 370 70 Td (6000 mm) Tj ET',
  'BT /F1 14 Tf 0 1 -1 0 70 270 Tm (4000 mm) Tj ET',
  'BT /F1 11 Tf 100 510 Td (Quant acceptance sheet 2 - rotated 90, cropped - rectangle 600 x 400 pt = 6000 x 4000 mm) Tj ET',
].join('\n')
objs.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 842 595] /CropBox [50 50 800 550] /Rotate 90 /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>')
objs.push(`<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`)

// The one font, shared by both pages (a standard-14 face needs no embedding).
objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')

let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'
const offsets = []
objs.forEach((o, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${o}\nendobj\n` })
const xref = Buffer.byteLength(out, 'latin1')
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
for (const off of offsets) out += String(off).padStart(10, '0') + ' 00000 n \n'
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
writeFileSync(process.argv[2], Buffer.from(out, 'latin1'))
console.log('wrote', process.argv[2], Buffer.byteLength(out, 'latin1'), 'bytes')
