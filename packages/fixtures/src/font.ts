/**
 * Just enough OpenType parsing to embed a TrueType font in a PDF:
 * WOFF 1.0 → sfnt, cmap (format 4) lookup, advance widths, unitsPerEm.
 */
import { inflateSync } from "node:zlib";

export type TrueTypeFont = {
  /** Raw sfnt bytes, embeddable as /FontFile2. */
  readonly sfnt: Uint8Array;
  readonly unitsPerEm: number;
  readonly ascent: number;
  readonly descent: number;
  glyphId(codePoint: number): number;
  /** Advance width in 1/1000 em (PDF glyph space). */
  advance(glyphId: number): number;
};

function tag(view: DataView, off: number): string {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

/** Decodes a WOFF 1.0 file into a plain sfnt (TTF). */
export function woffToSfnt(woff: Uint8Array): Uint8Array {
  const v = new DataView(woff.buffer, woff.byteOffset, woff.byteLength);
  if (tag(v, 0) !== "wOFF") throw new Error("not a WOFF 1.0 file");
  const flavor = v.getUint32(4);
  const numTables = v.getUint16(12);
  type Entry = { tag: string; data: Uint8Array; checksum: number };
  const entries: Entry[] = [];
  for (let i = 0; i < numTables; i++) {
    const base = 44 + i * 20;
    const offset = v.getUint32(base + 4);
    const compLength = v.getUint32(base + 8);
    const origLength = v.getUint32(base + 12);
    const raw = woff.subarray(offset, offset + compLength);
    const data = compLength < origLength ? new Uint8Array(inflateSync(raw)) : raw;
    if (data.length !== origLength) throw new Error("WOFF table length mismatch");
    entries.push({ tag: tag(v, base), data, checksum: v.getUint32(base + 16) });
  }
  entries.sort((a, b) => (a.tag < b.tag ? -1 : 1));
  const headerSize = 12 + numTables * 16;
  let size = headerSize;
  for (const e of entries) size += (e.data.length + 3) & ~3;
  const out = new Uint8Array(size);
  const o = new DataView(out.buffer);
  o.setUint32(0, flavor);
  o.setUint16(4, numTables);
  let pow = 1;
  let log = 0;
  while (pow * 2 <= numTables) {
    pow *= 2;
    log++;
  }
  o.setUint16(6, pow * 16);
  o.setUint16(8, log);
  o.setUint16(10, numTables * 16 - pow * 16);
  let dataOff = headerSize;
  entries.forEach((e, i) => {
    const rec = 12 + i * 16;
    for (let k = 0; k < 4; k++) o.setUint8(rec + k, e.tag.charCodeAt(k));
    o.setUint32(rec + 4, e.checksum);
    o.setUint32(rec + 8, dataOff);
    o.setUint32(rec + 12, e.data.length);
    out.set(e.data, dataOff);
    dataOff += (e.data.length + 3) & ~3;
  });
  return out;
}

export function parseTrueType(sfnt: Uint8Array): TrueTypeFont {
  const v = new DataView(sfnt.buffer, sfnt.byteOffset, sfnt.byteLength);
  const numTables = v.getUint16(4);
  const tables = new Map<string, { offset: number; length: number }>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(tag(v, rec), { offset: v.getUint32(rec + 8), length: v.getUint32(rec + 12) });
  }
  const table = (name: string) => {
    const t = tables.get(name);
    if (!t) throw new Error(`font has no '${name}' table`);
    return t;
  };

  const head = table("head").offset;
  const unitsPerEm = v.getUint16(head + 18);
  const hhea = table("hhea").offset;
  const ascent = v.getInt16(hhea + 4);
  const descent = v.getInt16(hhea + 6);
  const numHMetrics = v.getUint16(hhea + 34);
  const hmtx = table("hmtx").offset;

  // cmap: prefer (3,1) Windows Unicode BMP, format 4.
  const cmap = table("cmap").offset;
  const numSub = v.getUint16(cmap + 2);
  let sub = -1;
  for (let i = 0; i < numSub; i++) {
    const rec = cmap + 4 + i * 8;
    const platform = v.getUint16(rec);
    const encoding = v.getUint16(rec + 2);
    const off = cmap + v.getUint32(rec + 4);
    if (v.getUint16(off) === 4 && ((platform === 3 && encoding === 1) || platform === 0)) {
      sub = off;
      if (platform === 3) break;
    }
  }
  if (sub < 0) throw new Error("font has no format-4 Unicode cmap");
  const segX2 = v.getUint16(sub + 6);
  const endCodes = sub + 14;
  const startCodes = endCodes + segX2 + 2;
  const idDeltas = startCodes + segX2;
  const idRangeOffsets = idDeltas + segX2;

  const glyphId = (cp: number): number => {
    if (cp > 0xffff) return 0;
    for (let s = 0; s < segX2; s += 2) {
      const end = v.getUint16(endCodes + s);
      if (cp > end) continue;
      const start = v.getUint16(startCodes + s);
      if (cp < start) return 0;
      const delta = v.getInt16(idDeltas + s);
      const rangeOff = v.getUint16(idRangeOffsets + s);
      if (rangeOff === 0) return (cp + delta) & 0xffff;
      const gAddr = idRangeOffsets + s + rangeOff + (cp - start) * 2;
      const g = v.getUint16(gAddr);
      return g === 0 ? 0 : (g + delta) & 0xffff;
    }
    return 0;
  };

  const advance = (gid: number): number => {
    const idx = Math.min(gid, numHMetrics - 1);
    const units = v.getUint16(hmtx + idx * 4);
    return Math.round((units * 1000) / unitsPerEm);
  };

  return { sfnt, unitsPerEm, ascent, descent, glyphId, advance };
}
