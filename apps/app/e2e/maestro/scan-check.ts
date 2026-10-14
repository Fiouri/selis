/**
 * Checks the PDF scan.yaml made (pulled by scan.sh): `node scan-check.ts <pdf> <pages>` —
 * qpdf --check passes, pdf.js opens `pages` pages, and no embedded JPEG carries a metadata
 * segment (APP1 EXIF/XMP, APP3–APP13 maker data and IPTC, COM; APP2 only as the ICC colour
 * profile the WebView's encoder writes). The pages are re-encoded by
 * the scan worker, so this walks each JPEG's marker segments rather than searching the file for
 * strings: in camera pages' entropy-coded data, short strings such as "GPS" turn up by chance.
 * Exit 1 with the reasons on stderr.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pdfjsPageCount } from "@selis/fixtures/oracle";

const [path, pagesArg] = process.argv.slice(2);
if (!path || !pagesArg) {
  console.error("usage: node scan-check.ts <pdf> <pages>");
  process.exit(2);
}
const bytes = new Uint8Array(readFileSync(path));
const failures: string[] = [];
const check = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
if (check.status !== 0) failures.push(`qpdf --check exited ${String(check.status)}: ${`${check.stdout}${check.stderr}`.trim()}`);
const pages = await pdfjsPageCount(bytes);
if (pages !== Number(pagesArg)) failures.push(`pdf.js opened ${String(pages)} pages, expected ${pagesArg}`);

type Segment = { marker: number; at: number };

/** The marker segments of the JPEG at `start` up to its scan data (SOS). */
function segments(start: number): Segment[] {
  const markers: Segment[] = [];
  let i = start + 2;
  while (i + 4 <= bytes.length && bytes[i] === 0xff) {
    const marker = bytes[i + 1] ?? 0;
    markers.push({ marker, at: i });
    if (marker === 0xda) break;
    const length = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + length;
  }
  return markers;
}

let jpegs = 0;
for (let i = 0; i + 3 < bytes.length; i++) {
  // A JPEG stream starts with SOI followed by a marker; the scan worker writes JFIF (APP0).
  if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd8 || bytes[i + 2] !== 0xff) continue;
  const markers = segments(i);
  if (!markers.some((s) => s.marker === 0xda)) continue;
  jpegs += 1;
  const icc = (at: number) => new TextDecoder().decode(bytes.subarray(at + 4, at + 15)) === "ICC_PROFILE";
  const metadata = markers.filter(({ marker, at }) => (marker >= 0xe1 && marker <= 0xed && !(marker === 0xe2 && icc(at))) || marker === 0xfe);
  if (metadata.length > 0) failures.push(`JPEG at ${String(i)} has metadata segments ${metadata.map((m) => m.marker.toString(16)).join(", ")}`);
}
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log(`scan: ${String(pages)} pages, ${String(jpegs)} JPEG page(s) without metadata segments, ${(bytes.length / 1e6).toFixed(1)} MB, qpdf ok`);
