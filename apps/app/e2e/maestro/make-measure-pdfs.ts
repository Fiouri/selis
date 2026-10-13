/**
 * `node make-measure-pdfs.ts <dir> <count> <bytesEach>`: valid one-page PDFs ("Measure NN"),
 * each carrying an unreferenced random stream, so the library renders them and every file has
 * its own hash. Used by `pack.sh measure-pre` (pack-measure.yaml).
 */
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";

const [dir, countArg, eachArg] = process.argv.slice(2);
if (!dir || !countArg || !eachArg) throw new Error("usage: make-measure-pdfs.ts <dir> <count> <bytesEach>");
const count = Number(countArg);
const each = Number(eachArg);
mkdirSync(dir, { recursive: true });

for (let i = 1; i <= count; i++) {
  const label = String(i).padStart(2, "0");
  const fd = openSync(join(dir, `measure-${label}.pdf`), "w");
  let pos = 0;
  const offsets: number[] = [];
  const put = (data: string | Buffer): void => {
    const buf = typeof data === "string" ? Buffer.from(data, "latin1") : data;
    writeSync(fd, buf);
    pos += buf.length;
  };
  const content = `BT /F1 36 Tf 72 700 Td (Measure ${label}) Tj ET`;
  const filler = Math.max(0, each - 900);
  put("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n");
  offsets.push(pos);
  put("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n");
  offsets.push(pos);
  put("2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n");
  offsets.push(pos);
  put(
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>\nendobj\n",
  );
  offsets.push(pos);
  put(`4 0 obj\n<< /Length ${String(content.length)} >>\nstream\n${content}\nendstream\nendobj\n`);
  offsets.push(pos);
  put(`5 0 obj\n<< /Length ${String(filler)} >>\nstream\n`);
  for (let left = filler; left > 0; left -= 1 << 22) put(randomBytes(Math.min(left, 1 << 22)));
  put("\nendstream\nendobj\n");
  offsets.push(pos);
  put("6 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n");
  const xref = pos;
  const rows = offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  put(`xref\n0 7\n0000000000 65535 f \n${rows}`);
  put(`trailer\n<< /Size 7 /Root 1 0 R >>\nstartxref\n${String(xref)}\n%%EOF\n`);
  closeSync(fd);
}
console.log(`made ${String(count)} PDFs in ${dir}`);
