import { mkdirSync, writeFileSync } from "node:fs";
import { FIXTURES, FIXTURES_OUT_DIR, fixturePath } from "@selis/fixtures";

/** Generates the fixture corpus the specs import through the file chooser. */
export default function globalSetup(): void {
  mkdirSync(FIXTURES_OUT_DIR, { recursive: true });
  for (const fixture of FIXTURES) writeFileSync(fixturePath(fixture.file), fixture.build());
}
