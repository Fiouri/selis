export { createScanClient, type KeptPage, ScanClient, type ScanWorkerLike, type Still } from "./client";
export {
  clampPoint,
  defaultQuad,
  distance,
  fromBox,
  isConvex,
  mapQuad,
  placement,
  type Placement,
  type Point,
  type Quad,
  scaleQuad,
  type Size,
  smoothQuad,
  svgPoints,
  toBox,
  turn,
  unturn,
  withCorner,
} from "./geometry";
export { downscale } from "./pixels";
export type { Picture, PhotoSource } from "./protocol";
export { FILTERS, HINTS, type LiveFrame, type LiveHint, type PageEdits, type ScanFilter, simdSupported, type Stroke } from "./wasm";
