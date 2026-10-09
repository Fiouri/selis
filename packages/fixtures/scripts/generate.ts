/**
 * Writes the synthetic PDF corpus to packages/fixtures/out/.
 * Usage: npm run fixtures [-- <name> ...]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURES } from "../src/corpus.ts";
import { FIXTURES_OUT_DIR, fixturePath } from "../src/index.ts";

const only = new Set(process.argv.slice(2));
mkdirSync(FIXTURES_OUT_DIR, { recursive: true });
for (const fixture of FIXTURES) {
  if (only.size > 0 && !only.has(fixture.name)) continue;
  const started = performance.now();
  const bytes = fixture.build();
  writeFileSync(fixturePath(fixture.file), bytes);
  const ms = Math.round(performance.now() - started);
  const kib = (bytes.length / 1024).toFixed(1);
  console.log(`${fixture.file.padEnd(18)} ${String(fixture.pageCount).padStart(5)} pages  ${kib.padStart(9)} KiB  ${ms} ms`);
}
