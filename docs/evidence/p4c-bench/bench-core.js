// P4c spike: page detection + straightening, OpenCV.js (minimal imgproc build) vs Rust/imageproc
// (wasm32, raw ABI). Same algorithm on both sides. Runs in Node or in a WebView via CDP.
/* eslint-disable */
async function selisBench(cvReady, rustBytes, opts) {
  const o = Object.assign({ frames: 30, iterations: 200, photoW: 3000, photoH: 4000, straightenRuns: 3 }, opts || {});
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  // ---- synthetic frames: a page in perspective on a textured desk ----
  function solveHomography(src, dst) {
    // Maps dst -> src (8 unknowns), Gaussian elimination.
    const A = [], b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = dst[i], [u, v] = src[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
    }
    for (let c = 0; c < 8; c++) {
      let p = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      [A[c], A[p]] = [A[p], A[c]]; [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < 8; r++) if (r !== c) { const f = A[r][c] / A[c][c]; for (let k = c; k < 8; k++) A[r][k] -= f * A[c][k]; b[r] -= f * b[c]; }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return (x, y) => { const d = h[6] * x + h[7] * y + 1; return [(h[0] * x + h[1] * y + h[2]) / d, (h[3] * x + h[4] * y + h[5]) / d]; };
  }
  function scene(w, h, quad, seed) {
    const toPage = solveHomography([[0, 0], [850, 0], [850, 1100], [0, 1100]], quad);
    const rgba = new Uint8ClampedArray(w * h * 4);
    let s = seed | 1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
      const [u, v] = toPage(x + 0.5, y + 0.5);
      let c;
      if (u >= 0 && u < 850 && v >= 0 && v < 1100) {
        const line = (v / 1100 * 24) % 1;
        const ink = u > 85 && u < 765 && v > 80 && line < 0.12 && ((u / 9) | 0) % 7 !== 0;
        c = ink ? [40, 40, 36] : [232 - v / 40, 230 - v / 40, 224 - v / 40];
      } else {
        const g = 70 + (((x / 7 | 0) + (y / 23 | 0)) % 3) * 6 + ((s >>> 0) % 24);
        c = [g + 20, g + 8, g];
      }
      const i = (y * w + x) * 4; rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
    return rgba;
  }
  const FW = 240, FH = 320;
  const frames = [];
  for (let k = 0; k < o.frames; k++) {
    const j = (k % 7) * 3, t = (k % 5) * 4;
    const quad = [[40 + j, 50 + t], [195 - t, 40 + j], [215 - j, 285 - t], [25 + t, 290 - j]];
    frames.push({ quad, rgba: scene(FW, FH, quad, k + 1) });
  }

  // ---- Rust ----
  const trap = (name) => () => { throw new Error("unexpected wasm import " + name); };
  const { instance } = await WebAssembly.instantiate(rustBytes, {
    __wbindgen_placeholder__: { __wbindgen_describe: trap("describe") },
    __wbindgen_externref_xform__: { __wbindgen_externref_table_grow: trap("grow"), __wbindgen_externref_table_set_null: trap("set_null") },
  });
  const R = instance.exports;
  const rFrame = R.scan_alloc(FW * FH * 4), rOut = R.scan_alloc(32), rSize = R.scan_alloc(8);
  function rustDetect(rgba) {
    new Uint8Array(R.memory.buffer, rFrame, rgba.length).set(rgba);
    if (!R.scan_detect(rFrame, FW, FH, rOut)) return null;
    const f = new Float32Array(R.memory.buffer, rOut, 8);
    return [[f[0], f[1]], [f[2], f[3]], [f[4], f[5]], [f[6], f[7]]];
  }
  function rustStraighten(photo, w, h, quad, filter) {
    const p = R.scan_alloc(photo.length);
    new Uint8Array(R.memory.buffer, p, photo.length).set(photo);
    const q = new Float32Array(R.memory.buffer, rOut, 8); quad.flat().forEach((v, i) => (q[i] = v));
    const out = R.scan_straighten(p, w, h, rOut, 8_000_000, filter, rSize);
    if (!out) return null;
    const sz = new Uint32Array(R.memory.buffer, rSize, 2);
    const [ow, oh] = [sz[0], sz[1]];
    const copy = new Uint8ClampedArray(new Uint8Array(R.memory.buffer, out, ow * oh * 4));
    R.scan_free(out, ow * oh * 4);
    return { w: ow, h: oh, rgba: copy };
  }

  // ---- OpenCV ----
  const tCv0 = now();
  const cv = await cvReady;
  const cvInitMs = now() - tCv0;
  const src = new cv.Mat(FH, FW, cv.CV_8UC4), gray = new cv.Mat(), blur = new cv.Mat(), edges = new cv.Mat(), dil = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  function thresholds(g) {
    const hist = new Uint32Array(256); const d = g.data; for (let i = 0; i < d.length; i++) hist[d[i]]++;
    const pct = (share) => { const target = Math.floor(d.length * share); let seen = 0; for (let v = 0; v < 256; v++) { seen += hist[v]; if (seen >= target) return v; } return 255; };
    const spread = Math.max(pct(0.95) - pct(0.05), 16); const high = Math.min(Math.max(spread * 0.9, 30), 200);
    return [high * 0.4, high];
  }
  function cvDetect(rgba) {
    src.data.set(rgba);
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blur, new cv.Size(0, 0), 1.4);
    const [lo, hi] = thresholds(blur);
    cv.Canny(blur, edges, lo, hi, 3, true);
    cv.dilate(edges, dil, kernel);
    const contours = new cv.MatVector(), hier = new cv.Mat();
    cv.findContours(dil, contours, hier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const minArea = FW * FH * 0.12;
    let best = null, bestArea = 0;
    for (let i = 0; i < contours.size(); i++) {
      const c = contours.get(i), hull = new cv.Mat();
      cv.convexHull(c, hull, false, true);
      const area = cv.contourArea(hull);
      if (area >= minArea && area > bestArea) {
        const peri = cv.arcLength(hull, true);
        for (const eps of [0.02, 0.03, 0.045, 0.06]) {
          const approx = new cv.Mat();
          cv.approxPolyDP(hull, approx, eps * peri, true);
          if (approx.rows === 4) { const a = cv.contourArea(approx); if (a >= minArea && a > bestArea) { bestArea = a; best = Array.from(approx.data32S); } approx.delete(); break; }
          const n = approx.rows; approx.delete(); if (n < 4) break;
        }
      }
      hull.delete(); c.delete();
    }
    contours.delete(); hier.delete();
    return best && [[best[0], best[1]], [best[2], best[3]], [best[4], best[5]], [best[6], best[7]]];
  }
  function cvStraighten(photo, w, h, quad, filter) {
    const m = new cv.Mat(h, w, cv.CV_8UC4); m.data.set(photo);
    const d = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    let ow = Math.max(d(quad[0], quad[1]), d(quad[3], quad[2])), oh = Math.max(d(quad[0], quad[3]), d(quad[1], quad[2]));
    const s = Math.min(1, Math.sqrt(8_000_000 / (ow * oh))); ow = Math.round(ow * s); oh = Math.round(oh * s);
    const from = cv.matFromArray(4, 1, cv.CV_32FC2, quad.flat()), to = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, ow, 0, ow, oh, 0, oh]);
    const M = cv.getPerspectiveTransform(from, to), out = new cv.Mat();
    cv.warpPerspective(m, out, M, new cv.Size(ow, oh), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));
    let result = out;
    if (filter === 2) {
      const g = new cv.Mat(), bw = new cv.Mat(); cv.cvtColor(out, g, cv.COLOR_RGBA2GRAY);
      const r = Math.max(Math.floor(Math.min(ow, oh) / 40), 7);
      cv.adaptiveThreshold(g, bw, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 2 * r + 1, 12);
      result = new cv.Mat(); cv.cvtColor(bw, result, cv.COLOR_GRAY2RGBA); g.delete(); bw.delete(); out.delete();
    }
    const copy = new Uint8ClampedArray(result.data);
    [m, from, to, M, result].forEach((x) => x.delete());
    return { w: ow, h: oh, rgba: copy };
  }

  // ---- accuracy ----
  const err = (found, quad) => found ? Math.max(...found.map((p) => Math.min(...quad.map((q) => Math.hypot(p[0] - q[0], p[1] - q[1]))))) : Infinity;
  const accuracy = (fn) => { let hit = 0, worst = 0; for (const f of frames) { const e = err(fn(f.rgba), f.quad); if (e <= 4) hit++; worst = Math.max(worst, Math.min(e, 999)); } return { found: hit, of: frames.length, worstPx: +worst.toFixed(2) }; };

  // ---- timing ----
  const stats = (xs) => { const s = [...xs].sort((a, b) => a - b); const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))]; return { median: +q(0.5).toFixed(2), p95: +q(0.95).toFixed(2), max: +s[s.length - 1].toFixed(2) }; };
  const time = (fn) => { for (let i = 0; i < 20; i++) fn(frames[i % frames.length].rgba); const t = []; for (let i = 0; i < o.iterations; i++) { const a = now(); fn(frames[i % frames.length].rgba); t.push(now() - a); } return stats(t); };

  const result = { env: typeof navigator !== "undefined" ? navigator.userAgent : "node", cvInitMs: +cvInitMs.toFixed(1) };
  result.rust = { detect: time(rustDetect), accuracy: accuracy(rustDetect) };
  result.opencv = { detect: time(cvDetect), accuracy: accuracy(cvDetect) };

  // Full-size photo straightening (B&W).
  const pq = [[300, 420], [2650, 300], [2820, 3700], [180, 3800]];
  const photo = scene(o.photoW, o.photoH, pq, 99);
  const st = (fn) => { const t = []; let last; for (let i = 0; i < o.straightenRuns; i++) { const a = now(); last = fn(photo, o.photoW, o.photoH, pq, 2); t.push(now() - a); } return { ...stats(t), out: last && `${last.w}x${last.h}` }; };
  result.rust.straightenBW = st(rustStraighten);
  result.opencv.straightenBW = st(cvStraighten);
  result.rust.wasmMemoryMB = +(R.memory.buffer.byteLength / 1048576).toFixed(1);
  result.opencv.heapMB = +(((cv.HEAP8 && cv.HEAP8.buffer) || (cv.wasmMemory) || { byteLength: 0 }).byteLength / 1048576).toFixed(1);
  [src, gray, blur, edges, dil, kernel].forEach((x) => x.delete());
  return result;
}
if (typeof module === "object") module.exports = { selisBench };
