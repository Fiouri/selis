/**
 * Checks the version ocr.yaml made (pulled by ocr.sh): `node ocr-check.ts <pdf> <greek|english>`
 * — qpdf --check passes and pdf.js extracts ≥ 95 % of the words each scanned page shows
 * (@selis/fixtures `scannedWords`). Prints the share per page. Exit 1 with the reasons.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { scannedWords } from "@selis/fixtures";
import { pdfjsText } from "@selis/fixtures/oracle";

const [path, language] = process.argv.slice(2);
if (!path || (language !== "greek" && language !== "english")) {
  console.error("usage: node ocr-check.ts <pdf> <greek|english>");
  process.exit(2);
}
const key = (w: string) => w.normalize("NFC").replace(/^[«"'([]+|[»"'.,:;!?)\]]+$/gu, "");
const failures: string[] = [];
const check = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
if (check.status !== 0) failures.push(`qpdf --check exited ${String(check.status)}: ${`${check.stdout}${check.stderr}`.trim()}`);
const { pages } = await pdfjsText(new Uint8Array(readFileSync(path)));
pages.forEach((text, i) => {
  const pool = new Map<string, number>();
  for (const w of text.split(/\s+/).filter((x) => x !== "").map(key)) pool.set(w, (pool.get(w) ?? 0) + 1);
  const expected = scannedWords(language, i).map(key);
  const missing = expected.filter((w) => {
    const left = pool.get(w) ?? 0;
    if (left > 0) pool.set(w, left - 1);
    return left === 0;
  });
  const share = (expected.length - missing.length) / expected.length;
  console.log(`page ${String(i + 1)}: ${(share * 100).toFixed(1)} % of ${String(expected.length)} words; missing: ${missing.join(" ")}`);
  if (share < 0.95) failures.push(`page ${String(i + 1)}: only ${(share * 100).toFixed(1)} % of the words`);
});
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
