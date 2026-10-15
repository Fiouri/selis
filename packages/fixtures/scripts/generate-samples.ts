/**
 * Writes the store / website sample documents (src/samples.ts) to packages/fixtures/out/samples/<lang>/.
 * Usage: npm run samples -w @selis/fixtures
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES_OUT_DIR } from "../src/index.ts";
import { type SampleLanguage, samples } from "../src/samples.ts";

for (const lang of ["en", "el"] as SampleLanguage[]) {
  const dir = join(FIXTURES_OUT_DIR, "samples", lang);
  mkdirSync(dir, { recursive: true });
  for (const sample of samples(lang)) {
    const bytes = sample.build();
    writeFileSync(join(dir, sample.file), bytes);
    console.log(`${lang}/${sample.file.padEnd(28)} ${String(sample.pageCount).padStart(2)} pages  ${(bytes.length / 1024).toFixed(1).padStart(7)} KiB`);
  }
}
