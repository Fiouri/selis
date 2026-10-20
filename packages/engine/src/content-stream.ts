/**
 * A page content stream read operator by operator (ADR 0033), for the erase:
 * the current transformation matrix and line width through q / Q / cm / w /
 * gs, the paths as they are built and painted, and the XObjects drawn. Each
 * operation keeps its byte range, so a caller can replace one path or one
 * operand and leave every other byte as it was.
 *
 * Content is handled as Latin-1 text (one character per byte), which keeps
 * strings and inline image data intact.
 */
import type { Pt, Seg, Subpath } from "./path-clip";

/** PDF matrix [a b c d e f]: x' = a x + c y + e, y' = b x + d y + f. */
export type Matrix = readonly [number, number, number, number, number, number];
export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m × n (apply m, then n), the order of `cm` and form matrices. */
export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det, (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

export function apply(m: Matrix, p: Pt): Pt {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}

/** The largest stretch of the matrix (its largest singular value). */
export function maxScale(m: Matrix): number {
  const [a, b, c, d] = m;
  const s = a * a + b * b + c * c + d * d;
  const t = Math.sqrt((a * a + b * b - c * c - d * d) ** 2 + 4 * (a * c + b * d) ** 2);
  return Math.sqrt((s + t) / 2);
}

export function mapSubpaths(subpaths: readonly Subpath[], m: Matrix): Subpath[] {
  const map = (p: Pt) => apply(m, p);
  return subpaths.map((sp) => ({
    start: map(sp.start),
    closed: sp.closed,
    segs: sp.segs.map((s): Seg => (s.kind === "line" ? { kind: "line", to: map(s.to) } : { kind: "cubic", c1: map(s.c1), c2: map(s.c2), to: map(s.to) })),
  }));
}

export type Operand =
  | { readonly t: "num"; readonly v: number; readonly start: number; readonly end: number }
  | { readonly t: "name"; readonly v: string; readonly start: number; readonly end: number }
  | { readonly t: "other"; readonly start: number; readonly end: number };

export type Operation = { readonly op: string; readonly operands: readonly Operand[]; readonly start: number; readonly end: number };

const isWhite = (c: number) => c === 0 || c === 9 || c === 10 || c === 12 || c === 13 || c === 32;
const isDelim = (c: number) =>
  c === 0x28 || c === 0x29 || c === 0x3c || c === 0x3e || c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d || c === 0x2f || c === 0x25;

export class ContentSyntaxError extends Error {
  override readonly name = "ContentSyntaxError";
}

/** End of an inline image's data: the first "EI" between white-space (or at the end). */
function inlineImageEnd(s: string, from: number): number {
  for (let k = s.indexOf("EI", from); k >= 0; k = s.indexOf("EI", k + 1)) {
    const before = s.charCodeAt(k - 1);
    const after = k + 2 < s.length ? s.charCodeAt(k + 2) : 32;
    if (isWhite(before) && isWhite(after)) return k + 2;
  }
  return -1;
}

/** Splits a content stream into operations (operands + operator, with byte ranges). */
export function operations(s: string): Operation[] {
  const ops: Operation[] = [];
  let operands: Operand[] = [];
  let i = 0;
  const n = s.length;
  const code = (k: number) => s.charCodeAt(k);

  const skipSpace = () => {
    while (i < n) {
      const c = code(i);
      if (isWhite(c)) i++;
      else if (c === 0x25) while (i < n && code(i) !== 10 && code(i) !== 13) i++;
      else break;
    }
  };
  const skipLiteral = () => {
    let depth = 0;
    while (i < n) {
      const c = code(i++);
      if (c === 0x5c) i++;
      else if (c === 0x28) depth++;
      else if (c === 0x29 && --depth === 0) return;
    }
    throw new ContentSyntaxError("unterminated string");
  };
  const word = () => {
    const from = i;
    while (i < n && !isWhite(code(i)) && !isDelim(code(i))) i++;
    return s.slice(from, i);
  };
  /** Skips one operand of any kind (strings, arrays and dicts nest). */
  const skipValue = (): void => {
    skipSpace();
    const c = code(i);
    if (c === 0x28) skipLiteral();
    else if (c === 0x3c && code(i + 1) === 0x3c) {
      i += 2;
      for (;;) {
        skipSpace();
        if (i >= n) throw new ContentSyntaxError("unterminated dictionary");
        if (code(i) === 0x3e && code(i + 1) === 0x3e) {
          i += 2;
          return;
        }
        skipValue();
      }
    } else if (c === 0x3c) {
      const end = s.indexOf(">", i);
      if (end < 0) throw new ContentSyntaxError("unterminated hex string");
      i = end + 1;
    } else if (c === 0x5b) {
      i++;
      for (;;) {
        skipSpace();
        if (i >= n) throw new ContentSyntaxError("unterminated array");
        if (code(i) === 0x5d) {
          i++;
          return;
        }
        skipValue();
      }
    } else if (c === 0x2f) {
      i++;
      word();
    } else if (word() === "") i++;
  };

  for (;;) {
    skipSpace();
    if (i >= n) break;
    const start = i;
    const c = code(i);
    if (c === 0x2f) {
      i++;
      operands.push({ t: "name", v: decodeName(word()), start, end: i });
    } else if (c === 0x28 || c === 0x3c || c === 0x5b) {
      skipValue();
      operands.push({ t: "other", start, end: i });
    } else if (c === 0x5d || c === 0x3e || c === 0x29 || c === 0x7b || c === 0x7d) {
      i++; // stray delimiter: ignored, as viewers do
    } else {
      const w = word();
      if (w === "") {
        i++;
        continue;
      }
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
        operands.push({ t: "num", v: Number(w), start, end: i });
      } else if (w === "true" || w === "false" || w === "null") {
        operands.push({ t: "other", start, end: i });
      } else if (w === "BI") {
        // Inline image: dictionary up to ID, one white-space byte, data up to EI.
        const id = s.indexOf("ID", i);
        const end = id < 0 ? -1 : inlineImageEnd(s, id + 3);
        if (end < 0) throw new ContentSyntaxError("inline image without ID / EI");
        i = end;
        ops.push({ op: "BI", operands: [], start, end: i });
        operands = [];
      } else {
        ops.push({ op: w, operands, start: operands[0]?.start ?? start, end: i });
        operands = [];
      }
    }
  }
  return ops;
}

function decodeName(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

const nums = (op: Operation): number[] => op.operands.filter((o): o is Extract<Operand, { t: "num" }> => o.t === "num").map((o) => o.v);

export type PaintOp = "S" | "s" | "f" | "F" | "f*" | "B" | "B*" | "b" | "b*" | "n";
const PAINT = new Set<string>(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);

export type PaintEvent = {
  readonly op: PaintOp;
  /** The path as built, in the user space of `ctm`. */
  readonly subpaths: readonly Subpath[];
  readonly ctm: Matrix;
  readonly lineWidth: number;
  /** W or W* between the path and its painting operator. */
  readonly clip: "W" | "W*" | null;
  /** Byte range from the first path operator's operands to the painting operator. */
  readonly start: number;
  readonly end: number;
};

export type DoEvent = { readonly name: string; readonly ctm: Matrix; readonly nameStart: number; readonly nameEnd: number };

export type WalkHandlers = {
  /** Line width of an ExtGState resource (`/LW`), if it sets one. */
  lineWidthOf?: (gsName: string) => number | undefined;
  onPaint?: (e: PaintEvent) => void;
  onDo?: (e: DoEvent) => void;
};

type Building = { start: Pt; segs: Seg[]; closed: boolean };

/** Runs through the operations with the graphics state the erase needs. */
export function walk(ops: readonly Operation[], base: Matrix, handlers: WalkHandlers): void {
  let ctm = base;
  let lineWidth = 1;
  const stack: { ctm: Matrix; lineWidth: number }[] = [];
  let subpaths: Building[] = [];
  let current = null as Building | null;
  let point: Pt = { x: 0, y: 0 };
  let pathStart = -1;
  let clip: "W" | "W*" | null = null;

  const begin = (op: Operation) => {
    if (pathStart < 0) pathStart = op.start;
  };
  const moveTo = (p: Pt): Building => {
    const sp: Building = { start: p, segs: [], closed: false };
    subpaths.push(sp);
    current = sp;
    point = p;
    return sp;
  };
  const segTo = (seg: Seg) => {
    const sp = current && !current.closed ? current : moveTo(point);
    sp.segs.push(seg);
    point = seg.to;
  };

  for (const op of ops) {
    const v = nums(op);
    switch (op.op) {
      case "q":
        stack.push({ ctm, lineWidth });
        break;
      case "Q": {
        const top = stack.pop();
        if (top) ({ ctm, lineWidth } = top);
        break;
      }
      case "cm":
        if (v.length === 6) ctm = multiply(v as unknown as Matrix, ctm);
        break;
      case "w":
        if (v.length === 1) lineWidth = v[0] as number;
        break;
      case "gs": {
        const name = op.operands.find((o) => o.t === "name");
        const lw = name?.t === "name" ? handlers.lineWidthOf?.(name.v) : undefined;
        if (lw !== undefined) lineWidth = lw;
        break;
      }
      case "m":
        begin(op);
        if (v.length === 2) moveTo({ x: v[0] as number, y: v[1] as number });
        break;
      case "l":
        begin(op);
        if (v.length === 2) segTo({ kind: "line", to: { x: v[0] as number, y: v[1] as number } });
        break;
      case "c":
        begin(op);
        if (v.length === 6) {
          const [x1, y1, x2, y2, x3, y3] = v as [number, number, number, number, number, number];
          segTo({ kind: "cubic", c1: { x: x1, y: y1 }, c2: { x: x2, y: y2 }, to: { x: x3, y: y3 } });
        }
        break;
      case "v":
        begin(op);
        if (v.length === 4) {
          const [x2, y2, x3, y3] = v as [number, number, number, number];
          segTo({ kind: "cubic", c1: point, c2: { x: x2, y: y2 }, to: { x: x3, y: y3 } });
        }
        break;
      case "y":
        begin(op);
        if (v.length === 4) {
          const [x1, y1, x3, y3] = v as [number, number, number, number];
          segTo({ kind: "cubic", c1: { x: x1, y: y1 }, c2: { x: x3, y: y3 }, to: { x: x3, y: y3 } });
        }
        break;
      case "re":
        begin(op);
        if (v.length === 4) {
          const [x, y, w, h] = v as [number, number, number, number];
          const sp = moveTo({ x, y });
          sp.segs.push({ kind: "line", to: { x: x + w, y } }, { kind: "line", to: { x: x + w, y: y + h } }, { kind: "line", to: { x, y: y + h } });
          sp.closed = true;
          point = { x, y };
        }
        break;
      case "h":
        if (current) {
          current.closed = true;
          point = current.start;
        }
        break;
      case "W":
      case "W*":
        clip = op.op;
        break;
      case "Do": {
        const name = op.operands.find((o) => o.t === "name");
        if (name?.t === "name") handlers.onDo?.({ name: name.v, ctm, nameStart: name.start, nameEnd: name.end });
        break;
      }
      default:
        if (PAINT.has(op.op)) {
          if (pathStart >= 0) handlers.onPaint?.({ op: op.op as PaintOp, subpaths, ctm, lineWidth, clip, start: pathStart, end: op.end });
          subpaths = [];
          current = null;
          pathStart = -1;
          clip = null;
        }
    }
  }
}

/** A number for a content stream: at most 5 decimals, no exponent, no "-0". */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const r = Math.round(n * 1e5) / 1e5;
  if (r === 0) return "0";
  return r.toFixed(5).replace(/\.?0+$/, "");
}

/** Path construction operators for the subpaths. */
export function pathText(subpaths: readonly Subpath[]): string {
  const out: string[] = [];
  for (const sp of subpaths) {
    out.push(`${fmt(sp.start.x)} ${fmt(sp.start.y)} m`);
    for (const s of sp.segs) {
      if (s.kind === "line") out.push(`${fmt(s.to.x)} ${fmt(s.to.y)} l`);
      else out.push(`${fmt(s.c1.x)} ${fmt(s.c1.y)} ${fmt(s.c2.x)} ${fmt(s.c2.y)} ${fmt(s.to.x)} ${fmt(s.to.y)} c`);
    }
    if (sp.closed) out.push("h");
  }
  return out.join("\n");
}

/** Replaces byte ranges (non-overlapping) in `s`. */
export function splice(s: string, edits: readonly { start: number; end: number; text: string }[]): string {
  const sorted = [...edits].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const e of sorted) {
    out += s.slice(at, e.start) + e.text;
    at = e.end;
  }
  return out + s.slice(at);
}
