/**
 * Page counts LibreOffice gives the conversion corpus (ADR 0035 gate: ours within ±1). Run
 * locally where LibreOffice is installed; only the numbers are committed
 * (src/convert-reference.ts), never LibreOffice's PDFs.
 *
 *   npm run convert-corpus -w @selis/fixtures
 *   SOFFICE=<path to soffice(.com)> node packages/fixtures/scripts/convert-reference.ts
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { CONVERT_FIXTURES } from "../src/convert-corpus.ts";
import { FIXTURES_OUT_DIR } from "../src/index.ts";
import { pdfjsPageCount } from "../src/oracle.ts";

const soffice = process.env.SOFFICE;
if (!soffice) throw new Error("set SOFFICE to LibreOffice's soffice executable");
const dir = join(FIXTURES_OUT_DIR, "convert");
const out = join(dir, "lo");
mkdirSync(out, { recursive: true });
const profile = join(FIXTURES_OUT_DIR, "lo-profile");
const files = CONVERT_FIXTURES.map((f) => join(dir, f.file));
const run = spawnSync(soffice, [`-env:UserInstallation=${pathToFileURL(profile).href}`, "--headless", "--norestore", "--convert-to", "pdf", "--outdir", out, ...files], {
  encoding: "utf8",
  timeout: 900_000,
});
if (run.status !== 0) throw new Error(`LibreOffice failed: ${run.stderr}`);
const version = spawnSync(soffice, ["--version"], { encoding: "utf8" }).stdout.trim();

const lines: string[] = [];
for (const fixture of CONVERT_FIXTURES) {
  const pages = await pdfjsPageCount(new Uint8Array(readFileSync(join(out, fixture.file.replace(/\.(docx|xlsx)$/, ".pdf")))));
  lines.push(`  "${fixture.name}": ${String(pages)},`);
  console.log(`${fixture.file.padEnd(24)} ${String(pages).padStart(3)} pages`);
}
writeFileSync(
  join(import.meta.dirname, "..", "src", "convert-reference.ts"),
  `/**
 * Pages LibreOffice prints for each conversion-corpus file (scripts/convert-reference.ts).
 * ${version}
 */
export const LIBREOFFICE_PAGES: Readonly<Record<string, number>> = {
${lines.join("\n")}
};
`,
);
