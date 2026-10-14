/**
 * Checks every library file tools.yaml left on the device (pulled by tools.sh):
 * `qpdf --check` finds nothing wrong and pdf.js opens it (with the password when it needs one).
 * `node tools-check.ts <dir> <password>`; exit 1 with the reasons on stderr.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pdfjsPageCount } from "@selis/fixtures/oracle";

const [dir, password] = process.argv.slice(2);
if (!dir || !password) {
  console.error("usage: node tools-check.ts <dir> <password>");
  process.exit(2);
}

const failures: string[] = [];
const files = readdirSync(dir).filter((f) => f.endsWith(".pdf"));
for (const name of files) {
  const path = join(dir, name);
  const plain = spawnSync("qpdf", ["--check", path], { encoding: "utf8" });
  const needsPassword = plain.status !== 0 && /invalid password/i.test(`${plain.stdout}${plain.stderr}`);
  const check = needsPassword ? spawnSync("qpdf", ["--check", `--password=${password}`, path], { encoding: "utf8" }) : plain;
  if (check.error) throw new Error(`qpdf is not available (${check.error.message})`);
  if (check.status !== 0) failures.push(`${name}: qpdf --check exited ${String(check.status)}: ${`${check.stdout}${check.stderr}`.trim()}`);
  try {
    const pages = await pdfjsPageCount(new Uint8Array(readFileSync(path)), needsPassword ? password : undefined);
    if (pages < 1) failures.push(`${name}: pdf.js opened no pages`);
    console.log(`${name}: qpdf ok, pdf.js ${String(pages)} pages${needsPassword ? " (password)" : ""}`);
  } catch (err) {
    failures.push(`${name}: pdf.js could not open it (${String(err)})`);
  }
}
if (files.length === 0) failures.push(`no PDFs in ${dir}`);
if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}
