//! Document scan (P4c, ADR 0016; Scan 2.0, ADR 0032): finds the page in a camera frame, decides
//! when a live frame is steady and sharp enough to capture by itself, straightens the page and
//! applies the scan filters, touch-ups and rotation. Pure Rust on imageproc; compiled to
//! WebAssembly (`wasm32-unknown-unknown`) and run in a Web Worker of the WebView (see `wasm.rs`
//! for the exported ABI). The host build only exists for tests.

use image::{GrayImage, Luma, Rgba, RgbaImage};
use imageproc::contours::{BorderType, find_contours};
use imageproc::contrast::{adaptive_threshold, otsu_level};
use imageproc::edges::canny;
use imageproc::filter::gaussian_blur_f32;
use imageproc::geometric_transformations::{
    Border, Interpolation, Projection, rotate90, rotate180, rotate270, warp_into,
};
use imageproc::geometry::{approximate_polygon_dp, arc_length, contour_area, convex_hull};
use imageproc::morphology::dilate;
use imageproc::point::Point;

mod enhance;
pub mod live;
pub mod touchup;
#[cfg(target_arch = "wasm32")]
mod wasm;

pub use enhance::enhance;
pub use touchup::Stroke;

/// A page outline: top-left, top-right, bottom-right, bottom-left, in pixels of the image it
/// was found in.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Quad(pub [(f32, f32); 4]);

/// What a scanned page looks like after straightening.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Filter {
    /// The colours as photographed.
    Original,
    /// Grey, with the levels stretched so paper is white and ink is black.
    Grey,
    /// Black and white by a local (adaptive) threshold: shadows and uneven light drop out.
    BlackWhite,
    /// Colour, with the paper made evenly white (shadows and uneven light removed), levels
    /// stretched and strokes lightly sharpened (`enhance.rs`). The default since Scan 2.0.
    Enhance,
}

impl Filter {
    #[must_use]
    pub fn from_code(code: u32) -> Option<Self> {
        match code {
            0 => Some(Self::Original),
            1 => Some(Self::Grey),
            2 => Some(Self::BlackWhite),
            3 => Some(Self::Enhance),
            _ => None,
        }
    }
}

/// The smallest page accepted, as a share of the frame (smaller outlines are text blocks,
/// pictures on the page or clutter).
const MIN_AREA_SHARE: f64 = 0.08;
/// Polygon simplification tolerances tried in turn, as a share of the outline's perimeter.
const EPSILONS: [f64; 4] = [0.02, 0.03, 0.045, 0.06];
/// Corners sharper or flatter than this are not a photographed rectangle.
const MIN_CORNER_DEG: f64 = 35.0;
const MAX_CORNER_DEG: f64 = 145.0;

/// Finds the page in a small grey frame (about 320 px on the long side). `None` when nothing
/// page-like is there.
///
/// Outer contours of the edge map → convex hull → four corners (Douglas–Peucker), kept only
/// when every side runs along edges: clutter touching a page bends its hull into a wrong
/// quad whose sides then cross bare background. Contours come from the thickened edges (small
/// gaps closed) and from the thin ones (clutter that touches the page only through the
/// thickening stays apart); the largest well-supported outline wins.
#[must_use]
pub fn detect(gray: &GrayImage) -> Option<Quad> {
    let (w, h) = gray.dimensions();
    if w < 16 || h < 16 {
        return None;
    }
    let thin = canny(gray, CANNY_LOW, CANNY_HIGH);
    let thick = dilate(&thin, imageproc::distance_transform::Norm::LInf, 1);
    let min_area = f64::from(w) * f64::from(h) * MIN_AREA_SHARE;

    let mut best: Option<(f64, Quad)> = None;
    // Contours run along the outside of the edge pixels: this far outside the page's real
    // edge, in frame pixels.
    for (edges, outside) in [(&thick, 1.5), (&thin, 0.5)] {
        for contour in find_contours::<i32>(edges) {
            if contour.border_type != BorderType::Outer || contour.points.len() < 16 {
                continue;
            }
            let hull = convex_hull(contour.points.clone());
            if contour_area(&hull) < min_area {
                continue;
            }
            let mut candidates = four_corner_candidates(&hull);
            candidates.extend(four_corner_candidates(&contour.points));
            for corners in candidates {
                let area = contour_area(&corners);
                if area < min_area || !plausible(&corners) {
                    continue;
                }
                let quad = inset(&order(corners.map(|p| (p.x as f32, p.y as f32))), outside);
                let support = side_support(&thick, &quad);
                if support < MIN_SIDE_SUPPORT {
                    continue;
                }
                let score = area * f64::from(support);
                if best.as_ref().is_none_or(|(s, _)| score > *s) {
                    best = Some((score, quad));
                }
            }
        }
    }
    best.map(|(_, quad)| quad)
}

/// Every side of a found page lies on edge pixels for at least this share of its middle 80 %
/// (corners are often rounded, shadowed or out of frame).
const MIN_SIDE_SUPPORT: f32 = 0.7;

/// The share of the weakest side of `quad` that runs along edge pixels (±1 px).
fn side_support(edges: &GrayImage, quad: &Quad) -> f32 {
    const SAMPLES: u32 = 32;
    let (w, h) = (i64::from(edges.width()), i64::from(edges.height()));
    let on_edge = |x: f32, y: f32| {
        let (cx, cy) = (x.round() as i64, y.round() as i64);
        (-1..=1).any(|dy| {
            (-1..=1).any(|dx| {
                let (px, py) = (cx + dx, cy + dy);
                px >= 0
                    && py >= 0
                    && px < w
                    && py < h
                    && edges.get_pixel(px as u32, py as u32)[0] > 0
            })
        })
    };
    (0..4)
        .map(|i| {
            let (a, b) = (quad.0[i], quad.0[(i + 1) % 4]);
            let hits = (0..SAMPLES)
                .filter(|k| {
                    let t = 0.1 + 0.8 * (*k as f32 + 0.5) / SAMPLES as f32;
                    on_edge(a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t)
                })
                .count();
            hits as f32 / SAMPLES as f32
        })
        .fold(1.0, f32::min)
}

/// Long side of the frames `detect` works on.
pub const DETECT_SIZE: u32 = 320;

/// Finds the page in a full-size photo: `detect` on a small copy, then `refine` at full size.
#[must_use]
pub fn find_page(photo: &GrayImage) -> Option<Quad> {
    let scale = DETECT_SIZE as f32 / photo.width().max(photo.height()) as f32;
    let small = if scale < 1.0 {
        image::imageops::resize(
            photo,
            ((photo.width() as f32 * scale).round() as u32).max(1),
            ((photo.height() as f32 * scale).round() as u32).max(1),
            image::imageops::FilterType::Triangle,
        )
    } else {
        photo.clone()
    };
    let scale = scale.min(1.0);
    let found = detect(&small)?;
    Some(refine(
        photo,
        &Quad(found.0.map(|(x, y)| (x / scale, y / scale))),
    ))
}

/// Sharpens a page outline found in a small frame against the full-size grey photo: each side
/// is re-fitted to the strongest edge near it (searched along the side's normal, sub-pixel),
/// and the corners become the fitted sides' intersections. A side with too little edge
/// evidence keeps its old line. Used once per still; live frames do not need it.
#[must_use]
pub fn refine(gray: &GrayImage, quad: &Quad) -> Quad {
    const SAMPLES: usize = 48;
    let p = quad.0;
    let reach = (gray.width() as f32).hypot(gray.height() as f32) * 0.01;
    let sample = |x: f32, y: f32| -> Option<f32> {
        let (x0, y0) = (x.floor(), y.floor());
        if x0 < 0.0
            || y0 < 0.0
            || x0 + 1.0 >= gray.width() as f32
            || y0 + 1.0 >= gray.height() as f32
        {
            return None;
        }
        let (fx, fy) = (x - x0, y - y0);
        let at = |dx: u32, dy: u32| f32::from(gray.get_pixel(x0 as u32 + dx, y0 as u32 + dy)[0]);
        Some(
            (at(0, 0) * (1.0 - fx) + at(1, 0) * fx) * (1.0 - fy)
                + (at(0, 1) * (1.0 - fx) + at(1, 1) * fx) * fy,
        )
    };
    // Each side as (point, unit direction) after fitting.
    let lines: [((f32, f32), (f32, f32)); 4] = std::array::from_fn(|i| {
        let (a, b) = (p[i], p[(i + 1) % 4]);
        let len = dist(a, b).max(f32::EPSILON);
        let (dx, dy) = ((b.0 - a.0) / len, (b.1 - a.1) / len);
        let (nx, ny) = (-dy, dx);
        let mut hits: Vec<(f32, f32)> = Vec::with_capacity(SAMPLES);
        for k in 0..SAMPLES {
            let t = 0.1 + 0.8 * (k as f32 + 0.5) / SAMPLES as f32;
            let (cx, cy) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
            // The steepest brightness change along the normal, refined by a parabola.
            let steps = reach.ceil() as i32;
            let mut grads = Vec::with_capacity((2 * steps + 1) as usize);
            for s in -steps..=steps {
                let o = s as f32;
                let before = sample(cx + nx * (o - 1.0), cy + ny * (o - 1.0));
                let after = sample(cx + nx * (o + 1.0), cy + ny * (o + 1.0));
                grads.push(match (before, after) {
                    (Some(u), Some(v)) => (v - u).abs(),
                    _ => 0.0,
                });
            }
            // The page's own edge is the strong one nearest the outline found in the small
            // frame, not necessarily the strongest (print, a screen's content, a table edge).
            let strongest = grads.iter().copied().fold(0.0f32, f32::max);
            if strongest < 24.0 {
                continue;
            }
            let centre = steps as usize;
            let Some(best) = (1..grads.len() - 1)
                .filter(|&j| {
                    grads[j] >= strongest * 0.5
                        && grads[j] >= grads[j - 1]
                        && grads[j] >= grads[j + 1]
                })
                .min_by_key(|&j| j.abs_diff(centre))
            else {
                continue;
            };
            let peak = grads[best];
            let (l, r) = (grads[best - 1], grads[best + 1]);
            let denom = l - 2.0 * peak + r;
            let offset = if denom.abs() > f32::EPSILON {
                0.5 * (l - r) / denom
            } else {
                0.0
            };
            let o = best as f32 - steps as f32 + offset;
            hits.push((cx + nx * o, cy + ny * o));
        }
        fit_line(&hits).unwrap_or(((a.0, a.1), (dx, dy)))
    });
    let corners = std::array::from_fn(|i| {
        let ((ax, ay), (adx, ady)) = lines[(i + 3) % 4];
        let ((bx, by), (bdx, bdy)) = lines[i];
        let det = adx * bdy - ady * bdx;
        if det.abs() < 1e-4 {
            return p[i];
        }
        let t = ((bx - ax) * bdy - (by - ay) * bdx) / det;
        let corner = (ax + adx * t, ay + ady * t);
        // A refit that moves a corner far is a wrong edge, not a sharper one.
        if dist(corner, p[i]) > reach * 1.5 {
            p[i]
        } else {
            corner
        }
    });
    Quad(corners)
}

/// Least-squares line through `points` (as a point and unit direction), refitted once without
/// the points more than 1.5 px from the first fit. `None` with too few points.
fn fit_line(points: &[(f32, f32)]) -> Option<((f32, f32), (f32, f32))> {
    fn fit(points: &[(f32, f32)]) -> Option<((f32, f32), (f32, f32))> {
        if points.len() < 8 {
            return None;
        }
        let n = points.len() as f32;
        let (mx, my) = (
            points.iter().map(|p| p.0).sum::<f32>() / n,
            points.iter().map(|p| p.1).sum::<f32>() / n,
        );
        let (mut sxx, mut sxy, mut syy) = (0.0f32, 0.0f32, 0.0f32);
        for (x, y) in points {
            let (u, v) = (x - mx, y - my);
            sxx += u * u;
            sxy += u * v;
            syy += v * v;
        }
        // Principal direction of the scatter.
        let angle = 0.5 * (2.0 * sxy).atan2(sxx - syy);
        Some(((mx, my), (angle.cos(), angle.sin())))
    }
    let (c, d) = fit(points)?;
    let near: Vec<(f32, f32)> = points
        .iter()
        .copied()
        .filter(|(x, y)| ((x - c.0) * d.1 - (y - c.1) * d.0).abs() <= 1.5)
        .collect();
    fit(&near).or(Some((c, d)))
}

/// Moves each side of a clockwise quad `by` pixels inwards (the corners are the new sides'
/// intersections).
#[must_use]
pub fn inset(quad: &Quad, by: f32) -> Quad {
    let p = quad.0;
    // Each side as a point and a direction, shifted along its inward normal (clockwise on
    // screen with y down: the inside is to the right of the direction of travel).
    let sides: [((f32, f32), (f32, f32)); 4] = std::array::from_fn(|i| {
        let (a, b) = (p[i], p[(i + 1) % 4]);
        let (dx, dy) = (b.0 - a.0, b.1 - a.1);
        let len = dx.hypot(dy).max(f32::EPSILON);
        let (nx, ny) = (-dy / len, dx / len);
        ((a.0 + nx * by, a.1 + ny * by), (dx, dy))
    });
    let corners = std::array::from_fn(|i| {
        let ((ax, ay), (adx, ady)) = sides[(i + 3) % 4];
        let ((bx, by_), (bdx, bdy)) = sides[i];
        let det = adx * bdy - ady * bdx;
        if det.abs() < f32::EPSILON {
            return p[i];
        }
        let t = ((bx - ax) * bdy - (by_ - ay) * bdx) / det;
        (ax + adx * t, ay + ady * t)
    });
    Quad(corners)
}

/// The thickened edges `detect` traces (Canny, which blurs first with σ 1.4, dilated by one
/// pixel). For debugging.
#[must_use]
pub fn edge_map(gray: &GrayImage) -> GrayImage {
    dilate(
        &canny(gray, CANNY_LOW, CANNY_HIGH),
        imageproc::distance_transform::Norm::LInf,
        1,
    )
}

/// Canny hysteresis thresholds on Sobel magnitude (0–1140): a page against a desk is far
/// above the high one; paper grain and soft shadows stay under the low one.
const CANNY_LOW: f32 = 30.0;
const CANNY_HIGH: f32 = 80.0;

/// Most outline vertices whose four-corner subsets are tried.
const MAX_VERTICES: usize = 10;

/// Four-corner candidates of a closed outline (a convex hull or a contour): its Douglas–Peucker
/// simplification when that has four vertices, else every four of its vertices (in order)
/// when it has a few more — a page with clutter touching one side keeps its real corners
/// among them.
fn four_corner_candidates(outline: &[Point<i32>]) -> Vec<[Point<i32>; 4]> {
    let mut out: Vec<[Point<i32>; 4]> = Vec::new();
    let mut push = |quad: [Point<i32>; 4]| {
        if !out.contains(&quad) {
            out.push(quad);
        }
    };
    for eps in EPSILONS {
        let poly = simplify_closed(outline, eps);
        match poly.len() {
            0..=3 => break,
            4 => push([poly[0], poly[1], poly[2], poly[3]]),
            n if n <= MAX_VERTICES => {
                for i in 0..n {
                    for j in i + 1..n {
                        for k in j + 1..n {
                            for l in k + 1..n {
                                push([poly[i], poly[j], poly[k], poly[l]]);
                            }
                        }
                    }
                }
            }
            _ => {}
        }
    }
    out
}

/// Douglas–Peucker on a closed outline with tolerance `eps` × its perimeter. imageproc's
/// closed mode leaves out the closing side, so the outline is split into two open halves
/// between two far-apart points (corners, for a page; as OpenCV does).
fn simplify_closed(outline: &[Point<i32>], eps: f64) -> Vec<Point<i32>> {
    let Some(&first) = outline.first() else {
        return Vec::new();
    };
    let tolerance = arc_length(outline, true) * eps;
    let farthest = |from: Point<i32>| {
        outline
            .iter()
            .enumerate()
            .max_by_key(|(_, p)| (p.x - from.x).pow(2) + (p.y - from.y).pow(2))
            .map_or(0, |(i, _)| i)
    };
    let a = farthest(first);
    let b = farthest(outline[a]);
    if a == b {
        return Vec::new();
    }
    let (lo, hi) = (a.min(b), a.max(b));
    let second_half: Vec<Point<i32>> = outline[hi..]
        .iter()
        .chain(&outline[..=lo])
        .copied()
        .collect();
    let mut poly = approximate_polygon_dp(&outline[lo..=hi], tolerance, false);
    poly.pop();
    let mut rest = approximate_polygon_dp(&second_half, tolerance, false);
    rest.pop();
    poly.extend(rest);
    poly
}

/// Convex, with corner angles a photographed rectangle can have.
fn plausible(corners: &[Point<i32>; 4]) -> bool {
    let cross = |i: usize| {
        let (a, b, c) = (corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4]);
        i64::from(b.x - a.x) * i64::from(c.y - b.y) - i64::from(b.y - a.y) * i64::from(c.x - b.x)
    };
    let turns = [cross(0), cross(1), cross(2), cross(3)];
    if !(turns.iter().all(|t| *t > 0) || turns.iter().all(|t| *t < 0)) {
        return false;
    }
    (0..4).all(|i| {
        let prev = corners[(i + 3) % 4];
        let at = corners[i];
        let next = corners[(i + 1) % 4];
        let (ax, ay) = (f64::from(prev.x - at.x), f64::from(prev.y - at.y));
        let (bx, by) = (f64::from(next.x - at.x), f64::from(next.y - at.y));
        let norms = (ax.hypot(ay) * bx.hypot(by)).max(f64::EPSILON);
        let angle = ((ax * bx + ay * by) / norms)
            .clamp(-1.0, 1.0)
            .acos()
            .to_degrees();
        (MIN_CORNER_DEG..=MAX_CORNER_DEG).contains(&angle)
    })
}

/// Puts four corners in the order top-left, top-right, bottom-right, bottom-left.
#[must_use]
pub fn order(points: [(f32, f32); 4]) -> Quad {
    let cx = points.iter().map(|p| p.0).sum::<f32>() / 4.0;
    let cy = points.iter().map(|p| p.1).sum::<f32>() / 4.0;
    let mut sorted = points;
    // Clockwise on screen (y down), starting from the top-left quadrant.
    sorted.sort_by(|a, b| {
        let ta = (a.1 - cy).atan2(a.0 - cx);
        let tb = (b.1 - cy).atan2(b.0 - cx);
        ta.total_cmp(&tb)
    });
    // atan2 order starts at -π (left): rotate so the corner with the smallest x + y leads.
    let start = sorted
        .iter()
        .enumerate()
        .min_by(|a, b| (a.1.0 + a.1.1).total_cmp(&(b.1.0 + b.1.1)))
        .map_or(0, |(i, _)| i);
    Quad(std::array::from_fn(|i| sorted[(start + i) % 4]))
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    (a.0 - b.0).hypot(a.1 - b.1)
}

/// The straightened page's size for `quad`: the longer of each pair of opposite sides, scaled
/// down to at most `max_pixels`.
#[must_use]
pub fn output_size(quad: &Quad, max_pixels: u64) -> (u32, u32) {
    let [tl, tr, br, bl] = quad.0;
    let w = dist(tl, tr).max(dist(bl, br)).max(1.0);
    let h = dist(tl, bl).max(dist(tr, br)).max(1.0);
    let pixels = f64::from(w) * f64::from(h);
    let scale = if pixels > max_pixels as f64 {
        (max_pixels as f64 / pixels).sqrt() as f32
    } else {
        1.0
    };
    (
        (w * scale).round().max(1.0) as u32,
        (h * scale).round().max(1.0) as u32,
    )
}

/// Straightens the page `quad` of `image` into a `width × height` image and applies `filter`.
/// `None` when the outline is degenerate.
#[must_use]
pub fn straighten(
    image: &RgbaImage,
    quad: &Quad,
    width: u32,
    height: u32,
    filter: Filter,
) -> Option<RgbaImage> {
    let (w, h) = (width as f32, height as f32);
    let projection =
        Projection::from_control_points(quad.0, [(0.0, 0.0), (w, 0.0), (w, h), (0.0, h)])?;
    let mut out = RgbaImage::new(width, height);
    warp_into(
        image,
        projection,
        Interpolation::Bilinear,
        Border::Constant(Rgba([255, 255, 255, 255])),
        &mut out,
    );
    Some(apply(out, filter))
}

/// Applies `filter` to an already straight page.
#[must_use]
pub fn apply(image: RgbaImage, filter: Filter) -> RgbaImage {
    match filter {
        Filter::Original => image,
        Filter::Enhance => enhance(image),
        Filter::Grey => to_rgba(&stretch(&grey(&image))),
        Filter::BlackWhite => {
            let g = stretch(&grey(&image));
            // A block of about 1/40 of the page's short side: wider than a letter stroke,
            // narrower than a shadow. Inside large dark areas (a photo, a filled box) the local
            // mean is dark too, so anything well below the page's global ink/paper split stays
            // black instead of turning into an outline.
            let radius = (g.width().min(g.height()) / 40).max(7);
            let mut bw = adaptive_threshold(&gaussian_blur_f32(&g, 0.8), radius, 12);
            let dark = (u16::from(otsu_level(&g)) * 6 / 10) as u8;
            for (o, p) in bw.pixels_mut().zip(g.pixels()) {
                if p[0] < dark {
                    o.0[0] = 0;
                }
            }
            to_rgba(&bw)
        }
    }
}

/// Turns `image` clockwise by `quarter_turns` × 90°.
#[must_use]
pub fn rotate(image: RgbaImage, quarter_turns: u32) -> RgbaImage {
    match quarter_turns % 4 {
        1 => rotate90(&image),
        2 => rotate180(&image),
        3 => rotate270(&image),
        _ => image,
    }
}

/// A brush stroke of the touch-up eraser in page-relative units: points in 0–1 of the
/// straightened page (before rotation), radius as a share of its long side.
#[derive(Clone, Debug, PartialEq)]
pub struct RelativeStroke {
    pub radius: f32,
    pub points: Vec<(f32, f32)>,
}

/// How a page is made from its photo: the outline, the filter, touch-ups and rotation.
#[derive(Clone, Debug, PartialEq)]
pub struct Edits {
    pub filter: Filter,
    pub strokes: Vec<RelativeStroke>,
    pub quarter_turns: u32,
}

/// The page `quad` of `photo`, straightened to at most `max_pixels`, then filtered, touched up
/// and rotated (in that order: the eraser samples the filtered paper). `None` when the outline
/// is degenerate.
#[must_use]
pub fn render(photo: &RgbaImage, quad: &Quad, max_pixels: u64, edits: &Edits) -> Option<RgbaImage> {
    let (w, h) = output_size(quad, max_pixels);
    let mut page = straighten(photo, quad, w, h, edits.filter)?;
    if !edits.strokes.is_empty() {
        let long = w.max(h) as f32;
        let strokes: Vec<Stroke> = edits
            .strokes
            .iter()
            .map(|s| Stroke {
                radius: s.radius * long,
                points: s
                    .points
                    .iter()
                    .map(|(x, y)| (x * w as f32, y * h as f32))
                    .collect(),
            })
            .collect();
        touchup::erase(&mut page, &strokes);
    }
    Some(rotate(page, edits.quarter_turns))
}

/// Luma (BT.601) of an RGBA image.
#[must_use]
pub fn grey(image: &RgbaImage) -> GrayImage {
    let mut out = GrayImage::new(image.width(), image.height());
    for (o, p) in out.pixels_mut().zip(image.pixels()) {
        let [r, g, b, _] = p.0;
        let y = (299 * u32::from(r) + 587 * u32::from(g) + 114 * u32::from(b) + 500) / 1000;
        *o = Luma([y as u8]);
    }
    out
}

/// Stretches levels so the 1st percentile is black and the 99th white.
fn stretch(image: &GrayImage) -> GrayImage {
    let mut hist = [0u64; 256];
    for p in image.pixels() {
        hist[usize::from(p[0])] += 1;
    }
    let total: u64 = hist.iter().sum();
    let find = |share: f64| -> u8 {
        let target = (total as f64 * share) as u64;
        let mut seen = 0;
        for (v, c) in hist.iter().enumerate() {
            seen += c;
            if seen > target {
                return v as u8;
            }
        }
        255
    };
    let (lo, hi) = (find(0.01), find(0.99));
    if hi <= lo.saturating_add(8) {
        return image.clone();
    }
    let span = f32::from(hi - lo);
    let lut: [u8; 256] = std::array::from_fn(|v| {
        (((v as f32 - f32::from(lo)) / span) * 255.0).clamp(0.0, 255.0) as u8
    });
    let mut out = image.clone();
    for p in out.pixels_mut() {
        p.0[0] = lut[usize::from(p.0[0])];
    }
    out
}

fn to_rgba(image: &GrayImage) -> RgbaImage {
    let mut out = RgbaImage::new(image.width(), image.height());
    for (o, p) in out.pixels_mut().zip(image.pixels()) {
        *o = Rgba([p[0], p[0], p[0], 255]);
    }
    out
}

#[cfg(test)]
mod tests;

#[cfg(test)]
mod samples;

#[cfg(test)]
mod tests_scan2;
