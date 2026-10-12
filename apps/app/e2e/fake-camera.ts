/**
 * A fake camera for Chromium (`--use-file-for-fake-video-capture`): a Y4M clip
 * of the fixture transfer QR code (packages/fixtures/transfer/qr-matrix.txt,
 * kept current by selis-transfer's `qr::fixtures_are_current`), black on
 * white, centred in a 640×480 frame.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fixturePath } from "@selis/fixtures";

export const FAKE_CAMERA_FILE = fixturePath("transfer-qr.y4m");

const WIDTH = 640;
const HEIGHT = 480;
const FRAMES = 10;
const QUIET = 4;

export function writeFakeCamera(): void {
  const matrixPath = fileURLToPath(import.meta.resolve("@selis/fixtures/transfer/qr-matrix.txt"));
  const rows = readFileSync(matrixPath, "utf8").trim().split(/\r?\n/);
  const modules = rows.length + 2 * QUIET;
  const scale = Math.floor(Math.min(WIDTH, HEIGHT) * 0.85 / modules);
  const side = modules * scale;
  const left = Math.floor((WIDTH - side) / 2);
  const top = Math.floor((HEIGHT - side) / 2);

  // Luma: 235 white, 16 black (BT.601 video range); chroma neutral.
  const luma = new Uint8Array(WIDTH * HEIGHT).fill(235);
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (row[x] !== "#") continue;
      const px = left + (x + QUIET) * scale;
      const py = top + (y + QUIET) * scale;
      for (let dy = 0; dy < scale; dy += 1) luma.fill(16, (py + dy) * WIDTH + px, (py + dy) * WIDTH + px + scale);
    }
  });
  const chroma = new Uint8Array((WIDTH / 2) * (HEIGHT / 2)).fill(128);

  const header = Buffer.from(`YUV4MPEG2 W${WIDTH} H${HEIGHT} F10:1 Ip A1:1 C420jpeg\n`, "ascii");
  const frameHeader = Buffer.from("FRAME\n", "ascii");
  const parts: Buffer[] = [header];
  for (let i = 0; i < FRAMES; i += 1) parts.push(frameHeader, Buffer.from(luma), Buffer.from(chroma), Buffer.from(chroma));
  writeFileSync(FAKE_CAMERA_FILE, Buffer.concat(parts));
}
