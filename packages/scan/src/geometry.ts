/**
 * Page outlines on screen (P4c, ADR 0016): corner order, smoothing the live outline between
 * frames, mapping frame coordinates onto a video shown with `object-fit: cover` or an image
 * shown with `contain`, and the default outline when no page is found. Pure functions.
 */

export type Point = readonly [x: number, y: number];
/** Top-left, top-right, bottom-right, bottom-left. */
export type Quad = readonly [Point, Point, Point, Point];

export type Size = { readonly width: number; readonly height: number };

/** Where a `width × height` picture lands in a box with `object-fit: cover` or `contain`. */
export type Placement = { readonly scale: number; readonly left: number; readonly top: number };

export function placement(picture: Size, box: Size, fit: "cover" | "contain"): Placement {
  const sx = box.width / Math.max(1, picture.width);
  const sy = box.height / Math.max(1, picture.height);
  const scale = fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy);
  return { scale, left: (box.width - picture.width * scale) / 2, top: (box.height - picture.height * scale) / 2 };
}

export function mapQuad(quad: Quad, map: (p: Point) => Point): Quad {
  return [map(quad[0]), map(quad[1]), map(quad[2]), map(quad[3])];
}

/** Picture pixels → box pixels. */
export function toBox(quad: Quad, at: Placement): Quad {
  return mapQuad(quad, ([x, y]) => [at.left + x * at.scale, at.top + y * at.scale]);
}

/** Box pixels → picture pixels. */
export function fromBox(point: Point, at: Placement): Point {
  return [(point[0] - at.left) / at.scale, (point[1] - at.top) / at.scale];
}

export function scaleQuad(quad: Quad, sx: number, sy: number = sx): Quad {
  return mapQuad(quad, ([x, y]) => [x * sx, y * sy]);
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

/** The outline used when no page is found: the picture inset by `share` of its sides. */
export function defaultQuad(size: Size, share = 0.08): Quad {
  const dx = size.width * share;
  const dy = size.height * share;
  return [
    [dx, dy],
    [size.width - dx, dy],
    [size.width - dx, size.height - dy],
    [dx, size.height - dy],
  ];
}

/** A corner moved by hand stays inside the picture. */
export function clampPoint(point: Point, size: Size): Point {
  return [Math.min(Math.max(point[0], 0), size.width), Math.min(Math.max(point[1], 0), size.height)];
}

export function withCorner(quad: Quad, index: number, point: Point): Quad {
  const next: [Point, Point, Point, Point] = [quad[0], quad[1], quad[2], quad[3]];
  next[index] = point;
  return next;
}

/** Corner `i` (any integer, taken modulo 4). */
function corner(quad: Quad, i: number): Point {
  return quad[((i % 4) + 4) % 4] ?? quad[0];
}

/** True when the outline is a convex quadrilateral that turns one way (a straightenable page). */
export function isConvex(quad: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const a = corner(quad, i);
    const b = corner(quad, i + 1);
    const c = corner(quad, i + 2);
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) < 1e-9) return false;
    const s = Math.sign(cross);
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/**
 * Smooths the live outline between frames: a small move is eased (no jitter), a large one
 * (another page, the phone moved) jumps. `jump` is a distance in the quad's own units.
 */
export function smoothQuad(previous: Quad | null, next: Quad, jump: number, ease = 0.5): Quad {
  if (!previous) return next;
  const moved = Math.max(...next.map((p, i) => distance(p, corner(previous, i))));
  if (moved > jump) return next;
  const blend = (i: number): Point => {
    const p = corner(next, i);
    const q = corner(previous, i);
    return [q[0] + (p[0] - q[0]) * ease, q[1] + (p[1] - q[1]) * ease];
  };
  return [blend(0), blend(1), blend(2), blend(3)];
}

/** Quad → `points` attribute of an SVG polygon. */
export function svgPoints(quad: Quad): string {
  return quad.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
}
