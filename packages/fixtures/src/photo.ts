/**
 * Synthetic phone photos for the images → PDF tests (P4b): a JPEG (encoded by @napi-rs/canvas)
 * whose four quadrants have distinct colours, with an EXIF block like a camera writes (make,
 * model, date, orientation and GPS position) and optionally XMP, IPTC and a comment — the
 * metadata that must not reach the PDF.
 */
import { createCanvas } from "@napi-rs/canvas";

/** Quadrant colours of the stored (not rotated) image: top-left, top-right, bottom-left, bottom-right. */
export const PHOTO_QUADRANTS = {
  topLeft: [220, 30, 30],
  topRight: [30, 170, 60],
  bottomLeft: [40, 60, 220],
  bottomRight: [245, 245, 245],
} as const;

/** Strings planted in the metadata; none may appear in a PDF made from the photo. */
export const PHOTO_SECRETS = ["SelisCam", "Model X9", "2026:10:14 09:30:00", "Lat-Long", "selis-xmp-secret", "selis-iptc-secret", "selis-comment-secret"] as const;

export type PhotoOptions = {
  readonly width: number;
  readonly height: number;
  /** EXIF orientation 1–8. */
  readonly orientation: number;
  readonly quality?: number;
  /** Also XMP (APP1), IPTC (APP13) and a JPEG comment. */
  readonly extras?: boolean;
  /** Per-pixel noise on the quadrant colours, so the JPEG is as large as a real photo's. */
  readonly texture?: boolean;
};

function u16(v: number, le: boolean): number[] {
  return le ? [v & 0xff, (v >> 8) & 0xff] : [(v >> 8) & 0xff, v & 0xff];
}

function u32(v: number, le: boolean): number[] {
  return le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff] : [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

type Entry = { tag: number; type: number; count: number; value: number[] | { data: number[] } };

/** One IFD at `offset` (from the TIFF header); returns its bytes and those of its out-of-line data. */
function ifd(entries: readonly Entry[], offset: number, le: boolean, next = 0): number[] {
  const head: number[] = [...u16(entries.length, le)];
  const extra: number[] = [];
  const dataStart = offset + 2 + entries.length * 12 + 4;
  for (const e of entries) {
    head.push(...u16(e.tag, le), ...u16(e.type, le), ...u32(e.count, le));
    if (Array.isArray(e.value)) {
      const v = [...e.value];
      while (v.length < 4) v.push(0);
      head.push(...v);
    } else {
      head.push(...u32(dataStart + extra.length, le));
      extra.push(...e.value.data);
      if (extra.length % 2) extra.push(0);
    }
  }
  head.push(...u32(next, le));
  return [...head, ...extra];
}

const ascii = (s: string) => ({ data: [...Buffer.from(`${s}\0`, "latin1")] });
const rational = (pairs: ReadonlyArray<readonly [number, number]>, le: boolean) => ({
  data: pairs.flatMap(([n, d]) => [...u32(n, le), ...u32(d, le)]),
});

/** An EXIF APP1 segment (big-endian TIFF, as many phones write): IFD0 + GPS IFD. */
export function exifSegment(orientation: number): Uint8Array {
  const le = false;
  const ifd0Entries = (gpsOffset: number): Entry[] => [
    { tag: 0x010f, type: 2, count: PHOTO_SECRETS[0].length + 1, value: ascii(PHOTO_SECRETS[0]) },
    { tag: 0x0110, type: 2, count: PHOTO_SECRETS[1].length + 1, value: ascii(PHOTO_SECRETS[1]) },
    { tag: 0x0112, type: 3, count: 1, value: u16(orientation, le) },
    { tag: 0x0132, type: 2, count: PHOTO_SECRETS[2].length + 1, value: ascii(PHOTO_SECRETS[2]) },
    { tag: 0x8825, type: 4, count: 1, value: u32(gpsOffset, le) },
  ];
  // Size of IFD0 does not depend on the GPS offset value: lay it out once to learn it.
  const ifd0Size = ifd(ifd0Entries(0), 8, le).length;
  const gpsOffset = 8 + ifd0Size;
  const gps = ifd(
    [
      { tag: 0x0001, type: 2, count: 2, value: [...Buffer.from("N\0", "latin1")] },
      { tag: 0x0002, type: 5, count: 3, value: rational([[37, 1], [58, 1], [1234, 100]], le) },
      { tag: 0x0003, type: 2, count: 2, value: [...Buffer.from("E\0", "latin1")] },
      { tag: 0x0004, type: 5, count: 3, value: rational([[23, 1], [43, 1], [5678, 100]], le) },
      { tag: 0x0012, type: 2, count: PHOTO_SECRETS[3].length + 1, value: ascii(PHOTO_SECRETS[3]) },
    ],
    gpsOffset,
    le,
  );
  const tiff = [0x4d, 0x4d, 0x00, 0x2a, ...u32(8, le), ...ifd(ifd0Entries(gpsOffset), 8, le), ...gps];
  return segment(0xe1, [...Buffer.from("Exif\0\0", "latin1"), ...tiff]);
}

function segment(marker: number, payload: readonly number[]): Uint8Array {
  const len = payload.length + 2;
  return Uint8Array.from([0xff, marker, (len >> 8) & 0xff, len & 0xff, ...payload]);
}

/** Inserts `segments` right after SOI (and after JFIF APP0 when there is one). */
export function insertSegments(jpeg: Uint8Array, segments: readonly Uint8Array[]): Uint8Array {
  let at = 2;
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0) at = 4 + ((jpeg[4] ?? 0) << 8) + (jpeg[5] ?? 0);
  const total = segments.reduce((n, s) => n + s.length, 0);
  const out = new Uint8Array(jpeg.length + total);
  out.set(jpeg.subarray(0, at), 0);
  let pos = at;
  for (const s of segments) {
    out.set(s, pos);
    pos += s.length;
  }
  out.set(jpeg.subarray(at), pos);
  return out;
}

/** A phone-like JPEG: quadrant colours, EXIF with GPS, optionally XMP / IPTC / a comment. */
export async function makePhoto(options: PhotoOptions): Promise<Uint8Array> {
  const { width, height } = options;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const fill = (rgb: readonly number[], x: number, y: number) => {
    ctx.fillStyle = `rgb(${rgb.join(",")})`;
    ctx.fillRect(x, y, Math.ceil(width / 2), Math.ceil(height / 2));
  };
  fill(PHOTO_QUADRANTS.topLeft, 0, 0);
  fill(PHOTO_QUADRANTS.topRight, Math.floor(width / 2), 0);
  fill(PHOTO_QUADRANTS.bottomLeft, 0, Math.floor(height / 2));
  fill(PHOTO_QUADRANTS.bottomRight, Math.floor(width / 2), Math.floor(height / 2));
  if (options.texture) {
    // Row bands keep memory small for 12-MP photos.
    const band = 256;
    for (let y = 0; y < height; y += band) {
      const h = Math.min(band, height - y);
      const img = ctx.getImageData(0, y, width, h);
      for (let i = 0; i < img.data.length; i += 4) {
        const n = ((i * 2654435761 + y * 40503) >>> 24) - 128;
        img.data[i] = Math.max(0, Math.min(255, (img.data[i] ?? 0) + (n >> 2)));
        img.data[i + 1] = Math.max(0, Math.min(255, (img.data[i + 1] ?? 0) + (n >> 2)));
        img.data[i + 2] = Math.max(0, Math.min(255, (img.data[i + 2] ?? 0) + (n >> 2)));
      }
      ctx.putImageData(img, 0, y);
    }
  }
  const jpeg = new Uint8Array(await canvas.encode("jpeg", options.quality ?? 90));
  const segments = [exifSegment(options.orientation)];
  if (options.extras) {
    const xmp = `http://ns.adobe.com/xap/1.0/\0<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:Description>${PHOTO_SECRETS[4]}</rdf:Description></x:xmpmeta>`;
    segments.push(segment(0xe1, [...Buffer.from(xmp, "latin1")]));
    segments.push(segment(0xed, [...Buffer.from(`Photoshop 3.0\x008BIM${PHOTO_SECRETS[5]}`, "latin1")]));
    segments.push(segment(0xfe, [...Buffer.from(PHOTO_SECRETS[6], "latin1")]));
  }
  return insertSegments(jpeg, segments);
}
