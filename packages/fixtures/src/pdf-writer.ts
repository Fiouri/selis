/**
 * Minimal PDF 1.7 writer for synthesizing test fixtures. Supports indirect
 * objects, Flate streams, a classic xref table and the Standard Security
 * Handler (RC4-128, revision 3). Not a general-purpose PDF library.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { rc4 } from "./rc4.ts";

export class Name {
  readonly value: string;
  constructor(value: string) {
    this.value = value;
  }
}

export class Str {
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  /** PDFDocEncoding-safe ASCII text. */
  static ascii(text: string): Str {
    return new Str(new TextEncoder().encode(text));
  }
  /** UTF-16BE with BOM, for text strings outside ASCII. */
  static utf16(text: string): Str {
    const out = new Uint8Array(2 + text.length * 2);
    out[0] = 0xfe;
    out[1] = 0xff;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      out[2 + i * 2] = c >> 8;
      out[3 + i * 2] = c & 0xff;
    }
    return new Str(out);
  }
}

export class Ref {
  readonly num: number;
  constructor(num: number) {
    this.num = num;
  }
}

export class Raw {
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export type PdfValue = number | boolean | null | Name | Str | Ref | Raw | PdfValue[] | PdfDict;
export type PdfDict = { readonly [key: string]: PdfValue };

export class Stream {
  readonly dict: PdfDict;
  readonly data: Uint8Array;
  constructor(dict: PdfDict, data: Uint8Array) {
    this.dict = dict;
    this.data = data;
  }
}

export const n = (value: string): Name => new Name(value);
export const ref = (num: number): Ref => new Ref(num);

type Encryption = {
  key: Uint8Array;
  encryptRef: Ref;
};

const PASSWORD_PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00,
  0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

function md5(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("md5");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function padPassword(password: string): Uint8Array {
  const bytes = new TextEncoder().encode(password).slice(0, 32);
  const out = new Uint8Array(32);
  out.set(bytes);
  out.set(PASSWORD_PAD.subarray(0, 32 - bytes.length), bytes.length);
  return out;
}

function xorKey(key: Uint8Array, i: number): Uint8Array {
  return key.map((b) => b ^ i);
}

export class PdfWriter {
  private readonly objects: Array<PdfValue | Stream | undefined> = [];
  private encryption: Encryption | null = null;
  private readonly fileId: Uint8Array;
  private infoRef: Ref | null = null;
  private rootRef: Ref | null = null;

  constructor(seed: string) {
    // Deterministic file ID so regenerated fixtures are byte-identical.
    this.fileId = md5(new TextEncoder().encode(seed));
  }

  /** Reserves an object number to allow forward references. */
  reserve(): Ref {
    this.objects.push(undefined);
    return new Ref(this.objects.length);
  }

  set(target: Ref, value: PdfValue | Stream): Ref {
    this.objects[target.num - 1] = value;
    return target;
  }

  add(value: PdfValue | Stream): Ref {
    return this.set(this.reserve(), value);
  }

  /** Flate-compressed stream object. */
  addStream(dict: PdfDict, data: Uint8Array | string, compress = true): Ref {
    const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
    if (!compress) return this.add(new Stream(dict, bytes));
    return this.add(new Stream({ ...dict, Filter: n("FlateDecode") }, new Uint8Array(deflateSync(bytes, { level: 9 }))));
  }

  setRoot(root: Ref): void {
    this.rootRef = root;
  }

  setInfo(info: PdfDict): void {
    this.infoRef = this.add(info);
  }

  /** Standard Security Handler, V2 / R3, RC4 128-bit. */
  encrypt(userPassword: string, ownerPassword: string, permissions = -4): void {
    const userPad = padPassword(userPassword);
    // Algorithm 3: O entry.
    let ownerKey = md5(padPassword(ownerPassword));
    for (let i = 0; i < 50; i++) ownerKey = md5(ownerKey);
    let o = rc4(ownerKey, userPad);
    for (let i = 1; i <= 19; i++) o = rc4(xorKey(ownerKey, i), o);
    // Algorithm 2: file key.
    const p = new Uint8Array(4);
    new DataView(p.buffer).setInt32(0, permissions, true);
    let key = md5(userPad, o, p, this.fileId);
    for (let i = 0; i < 50; i++) key = md5(key);
    // Algorithm 5: U entry.
    let u = rc4(key, md5(PASSWORD_PAD, this.fileId));
    for (let i = 1; i <= 19; i++) u = rc4(xorKey(key, i), u);
    // Only the first 16 bytes are significant for R3; the rest is zero padding.
    const uFull = new Uint8Array(32);
    uFull.set(u);
    const encryptRef = this.add({
      Filter: n("Standard"),
      V: 2,
      R: 3,
      Length: 128,
      O: new Str(o),
      U: new Str(uFull),
      P: permissions,
    });
    this.encryption = { key, encryptRef };
  }

  toBytes(): Uint8Array {
    if (!this.rootRef) throw new Error("PDF root not set");
    const chunks: Uint8Array[] = [];
    let offset = 0;
    const enc = new TextEncoder();
    const push = (b: Uint8Array | string) => {
      const bytes = typeof b === "string" ? enc.encode(b) : b;
      chunks.push(bytes);
      offset += bytes.length;
    };
    push("%PDF-1.7\n");
    // Binary comment: marks the file as binary for transfer tools.
    push(Uint8Array.from([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));

    const offsets: number[] = [];
    this.objects.forEach((value, idx) => {
      const num = idx + 1;
      if (value === undefined) throw new Error(`object ${num} reserved but never set`);
      offsets[idx] = offset;
      push(`${num} 0 obj\n`);
      const encrypting = this.encryption !== null && this.encryption.encryptRef.num !== num;
      if (value instanceof Stream) {
        const data = encrypting ? this.encryptFor(num, value.data) : value.data;
        push(serialize({ ...value.dict, Length: data.length }, encrypting ? (b) => this.encryptFor(num, b) : null));
        push("\nstream\n");
        push(data);
        push("\nendstream");
      } else {
        push(serialize(value, encrypting ? (b) => this.encryptFor(num, b) : null));
      }
      push("\nendobj\n");
    });

    const xrefOffset = offset;
    const count = this.objects.length + 1;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
    push(xref);
    const id = new Str(this.fileId);
    const trailer: Record<string, PdfValue> = { Size: count, Root: this.rootRef, ID: [id, id] };
    if (this.infoRef) trailer.Info = this.infoRef;
    if (this.encryption) trailer.Encrypt = this.encryption.encryptRef;
    push(`trailer\n${serialize(trailer, null)}\nstartxref\n${xrefOffset}\n%%EOF\n`);

    const out = new Uint8Array(offset);
    let pos = 0;
    for (const c of chunks) {
      out.set(c, pos);
      pos += c.length;
    }
    return out;
  }

  private encryptFor(num: number, data: Uint8Array): Uint8Array {
    if (!this.encryption) return data;
    const { key } = this.encryption;
    const salt = Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0]);
    const objKey = md5(key, salt).subarray(0, Math.min(key.length + 5, 16));
    return rc4(objKey, data);
  }
}

function hex(bytes: Uint8Array): string {
  let s = "<";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return `${s}>`;
}

function escapeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.\-+]/g, (c) => `#${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

function serialize(value: PdfValue, encryptString: ((b: Uint8Array) => Uint8Array) | null): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in PDF");
    return Number.isInteger(value) ? String(value) : value.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
  }
  if (value instanceof Name) return `/${escapeName(value.value)}`;
  if (value instanceof Str) return hex(encryptString ? encryptString(value.bytes) : value.bytes);
  if (value instanceof Ref) return `${value.num} 0 R`;
  if (value instanceof Raw) return value.text;
  if (Array.isArray(value)) return `[${value.map((v) => serialize(v, encryptString)).join(" ")}]`;
  const entries = Object.entries(value).map(([k, v]) => `/${escapeName(k)} ${serialize(v, encryptString)}`);
  return `<<${entries.join(" ")}>>`;
}
