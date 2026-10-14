/**
 * Photos (P4b) in the mock backend. Tests use `window.__selisTest.photos`:
 *
 * - `nextPick(tokens | null)`: what the next photo picker returns (registered mock files;
 *   null = cancelled);
 * - `pickNext(photos)`: registers `{ name, bytes }` photos and makes them the next pick;
 * - `lastExport()`: the last shared page image `{ name, mime, bytes }` (or null).
 */
import type { CommandError, PhotoPick } from "./ipc";

type Deps = {
  fail: (code: CommandError["code"], message: string) => never;
  runOnce: <T>(command: string, requestId: string, work: () => Promise<T>) => Promise<T>;
  file: (token: string) => File | undefined;
  register: (file: File) => string;
  takeUpload: (uploadId: string) => Uint8Array;
};

export const PHOTO_COMMANDS = new Set(["pick_photos", "stage_photo", "share_export"]);

export function createMockPhotos(deps: Deps) {
  let nextPick: string[] | null = null;
  let lastExport: { name: string; mime: string; bytes: number[] } | null = null;

  const hooks = {
    nextPick: (tokens: string[] | null) => {
      nextPick = tokens;
    },
    pickNext: (photos: Array<{ name: string; bytes: number[] }>) => {
      nextPick = photos.map((p) => deps.register(new File([new Uint8Array(p.bytes)], p.name, { type: "image/jpeg" })));
    },
    lastExport: () => lastExport,
  };

  const handle = async (cmd: string, args: Record<string, unknown>): Promise<unknown> => {
    switch (cmd) {
      case "pick_photos":
        return deps.runOnce(cmd, String(args.requestId), () => {
          const pick: PhotoPick = nextPick && nextPick.length > 0 ? { status: "picked", sources: nextPick } : { status: "cancelled" };
          return Promise.resolve(pick);
        });
      case "stage_photo":
        return deps.runOnce(cmd, String(args.requestId), async () => {
          const file = deps.file(String(args.source)) ?? deps.fail("io", "unknown mock source");
          const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
          const image = (head[0] === 0xff && head[1] === 0xd8) || (head[0] === 0x89 && head[1] === 0x50);
          if (!image) deps.fail("invalidArgument", "not an image");
          // The browser build "stages" by handing out a blob URL (as stage_pdf does).
          return URL.createObjectURL(file);
        });
      case "share_export":
        return deps.runOnce(cmd, String(args.requestId), () => {
          const bytes = deps.takeUpload(String(args.uploadId));
          lastExport = { name: String(args.name), mime: String(args.mime), bytes: Array.from(bytes) };
          return Promise.resolve(true);
        });
      default:
        return deps.fail("invalidArgument", `unknown command ${cmd}`);
    }
  };

  return { handle, hooks };
}
