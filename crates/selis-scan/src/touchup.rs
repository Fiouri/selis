//! Touch-up eraser (Scan 2.0, ADR 0032): a brushed area of a straight page (a pen mark, a
//! finger, a stain) is filled with the colour of the paper around it — the per-channel median
//! of a ring just outside the stroke — with a one-pixel feathered edge.

use image::RgbaImage;

/// One brush stroke in page pixels: a polyline and the brush radius.
#[derive(Clone, Debug, PartialEq)]
pub struct Stroke {
    pub radius: f32,
    pub points: Vec<(f32, f32)>,
}

/// Distance from `p` to the segment `a`–`b`.
fn to_segment(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let (dx, dy) = (b.0 - a.0, b.1 - a.1);
    let len2 = dx * dx + dy * dy;
    let t = if len2 > f32::EPSILON {
        (((p.0 - a.0) * dx + (p.1 - a.1) * dy) / len2).clamp(0.0, 1.0)
    } else {
        0.0
    };
    (p.0 - (a.0 + dx * t)).hypot(p.1 - (a.1 + dy * t))
}

/// The median of a 256-bin histogram holding `n` values.
fn median(hist: &[u32; 256], n: u32) -> u8 {
    let mut seen = 0;
    for (v, c) in hist.iter().enumerate() {
        seen += c;
        if seen * 2 >= n {
            return v as u8;
        }
    }
    255
}

/// Applies `strokes` to `image` in order.
pub fn erase(image: &mut RgbaImage, strokes: &[Stroke]) {
    for stroke in strokes {
        erase_one(image, stroke);
    }
}

fn erase_one(image: &mut RgbaImage, stroke: &Stroke) {
    let (w, h) = image.dimensions();
    let Some(&first) = stroke.points.first() else {
        return;
    };
    let r = stroke.radius.max(1.0);
    let ring = (r * 0.6).max(3.0);
    let reach = r + ring;
    // The stroke's box, with the ring, clipped to the page.
    let (mut x0, mut y0, mut x1, mut y1) = (first.0, first.1, first.0, first.1);
    for &(x, y) in &stroke.points {
        x0 = x0.min(x);
        y0 = y0.min(y);
        x1 = x1.max(x);
        y1 = y1.max(y);
    }
    let bx0 = (x0 - reach).floor().max(0.0) as u32;
    let by0 = (y0 - reach).floor().max(0.0) as u32;
    let bx1 = ((x1 + reach).ceil().max(0.0) as u32).min(w);
    let by1 = ((y1 + reach).ceil().max(0.0) as u32).min(h);
    if bx1 <= bx0 || by1 <= by0 {
        return;
    }
    let (bw, bh) = ((bx1 - bx0) as usize, (by1 - by0) as usize);
    // Distance of each pixel of the box to the stroke, segment by segment (each segment only
    // visits its own neighbourhood, so a long stroke costs about its length × its width).
    let mut dist = vec![f32::MAX; bw * bh];
    let segments: Vec<((f32, f32), (f32, f32))> = if stroke.points.len() == 1 {
        vec![(first, first)]
    } else {
        stroke.points.windows(2).map(|s| (s[0], s[1])).collect()
    };
    for (a, b) in segments {
        let sx0 = ((a.0.min(b.0) - reach).floor().max(bx0 as f32) as u32).min(bx1);
        let sy0 = ((a.1.min(b.1) - reach).floor().max(by0 as f32) as u32).min(by1);
        let sx1 = ((a.0.max(b.0) + reach).ceil().max(0.0) as u32).min(bx1);
        let sy1 = ((a.1.max(b.1) + reach).ceil().max(0.0) as u32).min(by1);
        for y in sy0..sy1 {
            for x in sx0..sx1 {
                let d = to_segment((x as f32 + 0.5, y as f32 + 0.5), a, b);
                let cell = &mut dist[(y - by0) as usize * bw + (x - bx0) as usize];
                if d < *cell {
                    *cell = d;
                }
            }
        }
    }
    // The paper around the stroke: median of the ring.
    let mut hist = [[0u32; 256]; 3];
    let mut n = 0u32;
    for (i, d) in dist.iter().enumerate() {
        if *d > r && *d <= reach {
            let p = image.get_pixel(bx0 + (i % bw) as u32, by0 + (i / bw) as u32);
            for c in 0..3 {
                hist[c][usize::from(p[c])] += 1;
            }
            n += 1;
        }
    }
    if n == 0 {
        return;
    }
    let fill = [
        median(&hist[0], n),
        median(&hist[1], n),
        median(&hist[2], n),
    ];
    for (i, d) in dist.iter().enumerate() {
        // Full fill inside, a 1-px blend at the edge.
        let t = (r + 1.0 - d).clamp(0.0, 1.0);
        if t <= 0.0 {
            continue;
        }
        let p = image.get_pixel_mut(bx0 + (i % bw) as u32, by0 + (i / bw) as u32);
        for c in 0..3 {
            p[c] = (f32::from(p[c]) * (1.0 - t) + f32::from(fill[c]) * t).round() as u8;
        }
    }
}
