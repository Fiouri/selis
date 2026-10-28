/**
 * Writes the file-conversion corpus (12 DOCX + 8 XLSX, ADR 0035) to packages/fixtures/out/convert/.
 * Usage: npm run convert-corpus -w @selis/fixtures [-- <name> ...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONVERT_FIXTURES } from "../src/convert-corpus.ts";
import { FIXTURES_OUT_DIR } from "../src/index.ts";

const only = new Set(process.argv.slice(2));
const dir = join(FIXTURES_OUT_DIR, "convert");
mkdirSync(dir, { recursive: true });
for (const fixture of CONVERT_FIXTURES) {
  if (only.size > 0 && !only.has(fixture.name)) continue;
  const bytes = await fixture.build();
  writeFileSync(join(dir, fixture.file), bytes);
  console.log(`${fixture.file.padEnd(24)} ${String(fixture.words.length).padStart(6)} words  ${(bytes.length / 1024).toFixed(1).padStart(8)} KiB`);
}
