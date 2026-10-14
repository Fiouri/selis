/**
 * `node make-photos.ts <dir> <count>`: phone-like photos for images.yaml (12 MP, textured so
 * each JPEG is a few MB, EXIF orientation 1–8 in turn, EXIF/GPS/XMP/IPTC/comment metadata).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makePhoto } from "@selis/fixtures";

const [dir, countArg] = process.argv.slice(2);
if (!dir || !countArg) throw new Error("usage: make-photos.ts <dir> <count>");
mkdirSync(dir, { recursive: true });
let total = 0;
for (let i = 0; i < Number(countArg); i++) {
  const orientation = (i % 8) + 1;
  const bytes = await makePhoto({ width: 4000, height: 3000, orientation, quality: 88, extras: true, texture: true });
  writeFileSync(join(dir, `selis-photo-${String(i + 1).padStart(2, "0")}.jpg`), bytes);
  total += bytes.length;
}
console.log(`made ${countArg} photos, ${(total / 1e6).toFixed(1)} MB`);
