import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export {
  ENCRYPTED_PASSWORD,
  ERASE_IMAGE_SIZE,
  ERASE_TEXT,
  FIXTURES,
  type Fixture,
  type FixtureName,
  GREEK_TEXT,
  greekGlyphHex,
  LARGE_PAGE_COUNT,
  LEAKY_SECRET_LINE,
  leakyDocument,
  ownerPasswordDocument,
  SHARED_TEXT,
} from "./corpus.ts";
export { SCANNED_DPI, SCANNED_TEXT, type ScannedLanguage, scannedWords } from "./scanned.ts";
export { exifSegment, insertSegments, makePhoto, PHOTO_QUADRANTS, PHOTO_SECRETS, type PhotoOptions } from "./photo.ts";

/** Directory where `npm run fixtures` writes the generated corpus (git-ignored). */
export const FIXTURES_OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "out");

export function fixturePath(file: string): string {
  return join(FIXTURES_OUT_DIR, file);
}
