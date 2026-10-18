//! The Enhance filter (Scan 2.0, ADR 0032): colour kept, shadows and uneven light removed.
//!
//! The paper's brightness is estimated on a small copy of the page (box-averaged to
//! `BG_SIDE` px, then a morphological close — a max filter followed by a min filter of the
//! same radius — removes the ink, then a blur), and each channel of the page is divided by it,
//! so paper becomes white wherever the light fell. Then the levels are stretched (1st
//! percentile black, 99th white) and a light unsharp mask on the luma crisps the strokes.
//! Three passes over the full page; everything else works on the small copy.

use image::{Rgb, RgbImage, RgbaImage};
use imageproc::filter::gaussian_blur_f32;

/// Long side of the background estimate.
const BG_SIDE: u32 = 192;
/// Close radius on that copy: dark marks up to about 2 × this (≈ 6 % of the page) are ink,
/// larger ones are left as they are (see `FLOOR`).
const CLOSE_RADIUS: usize = 6;
/// The background may not fall below this share of the paper's level: large dark areas
/// (photos, filled boxes) are content, not shadow, and must stay dark.
const FLOOR: f32 = 0.45;
/// Strength of the unsharp mask on the luma.
const SHARPEN_AMOUNT: f32 = 0.8;

/// Box-averages `image` to `sw × sh` (every source pixel read once).
fn box_down(image: &RgbaImage, sw: u32, sh: u32) -> RgbImage {
    let (w, h) = image.dimensions();
    let mut acc = vec![[0u64; 4]; (sw * sh) as usize];
    for (y, row) in image.rows().enumerate() {
        let cy = (y as u64 * u64::from(sh) / u64::from(h)) as usize;
        for (x, p) in row.enumerate() {
            let cx = (x as u64 * u64::from(sw) / u64::from(w)) as usize;
            let cell = &mut acc[cy * sw as usize + cx];
            cell[0] += u64::from(p[0]);
            cell[1] += u64::from(p[1]);
            cell[2] += u64::from(p[2]);
            cell[3] += 1;
        }
    }
    RgbImage::from_fn(sw, sh, |x, y| {
        let c = acc[(y * sw + x) as usize];
        let n = c[3].max(1);
        Rgb([(c[0] / n) as u8, (c[1] / n) as u8, (c[2] / n) as u8])
    })
}

/// A separable square max (`max = true`) or min filter of `radius` on one channel, in place.
fn rank_filter(image: &mut RgbImage, channel: usize, radius: usize, max: bool) {
    let (w, h) = (image.width() as usize, image.height() as usize);
    let pick = |a: u8, b: u8| if max { a.max(b) } else { a.min(b) };
    let mut line = vec![0u8; w.max(h)];
    let mut out = vec![0u8; w.max(h)];
    let mut pass = |image: &mut RgbImage, horizontal: bool| {
        let (len, lines) = if horizontal { (w, h) } else { (h, w) };
        for l in 0..lines {
            for (i, v) in line.iter_mut().enumerate().take(len) {
                let (x, y) = if horizontal { (i, l) } else { (l, i) };
                *v = image.get_pixel(x as u32, y as u32)[channel];
            }
            for (i, o) in out.iter_mut().enumerate().take(len) {
                let lo = i.saturating_sub(radius);
                let hi = (i + radius).min(len - 1);
                *o = line[lo..=hi]
                    .iter()
                    .copied()
                    .fold(if max { 0 } else { 255 }, pick);
            }
            for (i, o) in out.iter().enumerate().take(len) {
                let (x, y) = if horizontal { (i, l) } else { (l, i) };
                image.get_pixel_mut(x as u32, y as u32)[channel] = *o;
            }
        }
    };
    pass(image, true);
    pass(image, false);
}

/// The paper's colour under the page, on a small grid (`BG_SIDE` on the long side).
fn background(image: &RgbaImage) -> RgbImage {
    let (w, h) = image.dimensions();
    let scale = (BG_SIDE as f32 / w.max(h) as f32).min(1.0);
    let sw = ((w as f32 * scale).round() as u32).max(1);
    let sh = ((h as f32 * scale).round() as u32).max(1);
    let mut bg = box_down(image, sw, sh);
    for c in 0..3 {
        rank_filter(&mut bg, c, CLOSE_RADIUS, true);
        rank_filter(&mut bg, c, CLOSE_RADIUS, false);
    }
    // The paper's level per channel: the 95th percentile of the estimate.
    let mut floor = [0u8; 3];
    for (c, f) in floor.iter_mut().enumerate() {
        let mut hist = [0u32; 256];
        for p in bg.pixels() {
            hist[usize::from(p[c])] += 1;
        }
        let target = (sw * sh) as f32 * 0.95;
        let mut seen = 0u32;
        let level = hist
            .iter()
            .position(|n| {
                seen += n;
                seen as f32 >= target
            })
            .unwrap_or(255);
        *f = (level as f32 * FLOOR) as u8;
    }
    for p in bg.pixels_mut() {
        for c in 0..3 {
            p[c] = p[c].max(floor[c]).max(1);
        }
    }
    gaussian_blur_f32(&bg, CLOSE_RADIUS as f32)
}

fn luma(p: &[u8]) -> u8 {
    ((299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2]) + 500) / 1000) as u8
}

/// Where full-size coordinate `i` of `full` falls on a grid of `small` cells: the two
/// neighbouring cells and the weight of the second (bilinear, cell centres aligned).
fn taps(i: u32, full: u32, small: u32) -> (usize, usize, f32) {
    let f = ((i as f32 + 0.5) * small as f32 / full as f32 - 0.5).clamp(0.0, (small - 1) as f32);
    let a = f.floor() as u32;
    (a as usize, (a + 1).min(small - 1) as usize, f - a as f32)
}

/// The Enhance filter on a straight page.
#[must_use]
pub fn enhance(mut image: RgbaImage) -> RgbaImage {
    let (w, h) = image.dimensions();
    if w < 8 || h < 8 {
        return image;
    }
    let bg = background(&image);
    let (sw, sh) = bg.dimensions();
    let columns: Vec<(usize, usize, f32)> = (0..w).map(|x| taps(x, w, sw)).collect();
    // Divide by the background (paper → white) and count the luma levels. The background is
    // interpolated between rows of the small grid once per page row, then across.
    let mut hist = [0u64; 256];
    let mut grid_row = vec![[0f32; 3]; sw as usize];
    let raw = bg.as_raw();
    for (y, row) in image.rows_mut().enumerate() {
        let (y0, y1, ty) = taps(y as u32, h, sh);
        for (x, cell) in grid_row.iter_mut().enumerate() {
            for (c, v) in cell.iter_mut().enumerate() {
                let top = f32::from(raw[(y0 * sw as usize + x) * 3 + c]);
                let bottom = f32::from(raw[(y1 * sw as usize + x) * 3 + c]);
                // Reciprocal, so each pixel multiplies.
                *v = 255.0 / (top + (bottom - top) * ty).max(1.0);
            }
        }
        for (p, &(x0, x1, tx)) in row.zip(&columns) {
            let (a, b) = (grid_row[x0], grid_row[x1]);
            for c in 0..3 {
                let scale = a[c] + (b[c] - a[c]) * tx;
                p[c] = (f32::from(p[c]) * scale).min(255.0) as u8;
            }
            hist[usize::from(luma(&p.0))] += 1;
        }
    }
    // Levels: 1st percentile black, 99th white (the same curve on every channel).
    let total: u64 = hist.iter().sum();
    let find = |share: f64| -> u8 {
        let target = (total as f64 * share) as u64;
        let mut seen = 0;
        for (v, n) in hist.iter().enumerate() {
            seen += n;
            if seen > target {
                return v as u8;
            }
        }
        255
    };
    let (lo, hi) = (find(0.01), find(0.99));
    let lut: [u8; 256] = if hi > lo.saturating_add(8) {
        let span = f32::from(hi - lo);
        std::array::from_fn(|v| {
            (((v as f32 - f32::from(lo)) / span) * 255.0).clamp(0.0, 255.0) as u8
        })
    } else {
        std::array::from_fn(|v| v as u8)
    };
    let mut y_plane = vec![0u8; (w * h) as usize];
    for (p, o) in image.pixels_mut().zip(y_plane.iter_mut()) {
        for c in 0..3 {
            p[c] = lut[usize::from(p[c])];
        }
        *o = luma(&p.0);
    }
    // Unsharp mask on the luma (a 3 × 3 binomial blur, σ ≈ 0.85 px), added to every channel
    // (no colour fringes). The page's outermost pixels are left as they are.
    let (wu, hu) = (w as usize, h as usize);
    let raw = image.as_mut();
    for y in 1..hu - 1 {
        for x in 1..wu - 1 {
            let at = |dx: usize, dy: usize| u32::from(y_plane[(y + dy - 1) * wu + x + dx - 1]);
            let blur = (at(0, 0)
                + 2 * at(1, 0)
                + at(2, 0)
                + 2 * at(0, 1)
                + 4 * at(1, 1)
                + 2 * at(2, 1)
                + at(0, 2)
                + 2 * at(1, 2)
                + at(2, 2)) as f32
                / 16.0;
            let detail = (at(1, 1) as f32 - blur) * SHARPEN_AMOUNT;
            if detail.abs() < 0.5 {
                continue;
            }
            let i = (y * wu + x) * 4;
            for c in 0..3 {
                raw[i + c] = (f32::from(raw[i + c]) + detail).clamp(0.0, 255.0) as u8;
            }
        }
    }
    image
}
