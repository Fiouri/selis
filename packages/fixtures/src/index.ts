import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export {
  ENCRYPTED_PASSWORD,
  FIXTURES,
  type Fixture,
  type FixtureName,
  GREEK_TEXT,
  greekGlyphHex,
  LARGE_PAGE_COUNT,
  LEAKY_SECRET_LINE,
  leakyDocument,
  ownerPasswordDocument,
} from "./corpus.ts";

/** Directory where `npm run fixtures` writes the generated corpus (git-ignored). */
export const FIXTURES_OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

export function fixturePath(file: string): string {
  return join(FIXTURES_OUT_DIR, file);
}
