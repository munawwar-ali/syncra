/**
 * Minimal one-page PDF writer (BIL-03): Helvetica text only, uncompressed, so the output can be read
 * and tested without a PDF library. Text is restricted to Latin-1; anything else becomes '?'.
 */

const escapePdf = (s: string): string =>
  s.replace(/[^\x20-\x7e]/g, '?').replace(/([\\()])/g, '\\$1');

export function textPdf(title: string, lines: string[]): Buffer {
  const content: string[] = [
    'BT',
    '/F1 16 Tf',
    '56 790 Td',
    `(${escapePdf(title)}) Tj`,
    '/F1 10 Tf',
    '0 -26 Td',
    '14 TL',
  ];
  for (const line of lines) content.push(`(${escapePdf(line)}) Tj T*`);
  content.push('ET');
  const stream = content.join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${String(Buffer.byteLength(stream, 'latin1'))} >>\nstream\n${stream}\nendstream`,
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${String(i + 1)} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${String(objects.length + 1)}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${String(objects.length + 1)} /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
