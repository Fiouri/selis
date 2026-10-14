//! Writes the stored scan sample photos (`packages/fixtures/scan/*.jpg` + `samples.json`):
//! document pages photographed in perspective on different desks, with uneven light, blur,
//! sensor noise and JPEG compression. Deterministic; the corners are the ground truth.
//!
//! `cargo run -p selis-scan --example make-samples --release -- packages/fixtures/scan`

use image::{GrayImage, Luma, Rgb, RgbImage};
use imageproc::filter::gaussian_blur_f32;
use imageproc::geometric_transformations::Projection;

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }
    fn unit(&mut self) -> f32 {
        (self.next() % 10_000) as f32 / 10_000.0
    }
}

#[derive(Clone, Copy)]
enum Desk {
    Wood,
    Granite,
    Fabric,
    LightGrey,
}

#[derive(Clone, Copy)]
enum Layout {
    Letter,
    Table,
    Receipt,
}

struct Sample {
    name: &'static str,
    layout: Layout,
    desk: Desk,
    corners: [(f32, f32); 4],
    /// Darkening across the page: (strength, direction x, direction y).
    shadow: (f32, f32, f32),
    blur: f32,
    seed: u64,
}

const W: u32 = 900;
const H: u32 = 1200;

/// A page with text-like lines (words as dark blocks), drawn at `pw × ph`.
fn page(layout: Layout, pw: u32, ph: u32, rng: &mut Rng) -> GrayImage {
    let mut img = GrayImage::from_pixel(pw, ph, Luma([244]));
    let block = |img: &mut GrayImage, x0: u32, y0: u32, w: u32, h: u32, v: u8| {
        for y in y0..(y0 + h).min(ph) {
            for x in x0..(x0 + w).min(pw) {
                img.put_pixel(x, y, Luma([v]));
            }
        }
    };
    let margin = pw / 10;
    let line_h = ph / 60;
    let mut y = ph / 12;
    // Title.
    block(&mut img, margin, y, pw / 2, line_h * 2, 30);
    y += line_h * 5;
    let rows = match layout {
        Layout::Letter => 34,
        Layout::Table => 22,
        Layout::Receipt => 40,
    };
    for r in 0..rows {
        let mut x = margin;
        let end = if r % 7 == 6 { pw / 2 } else { pw - margin };
        while x + 20 < end {
            let word = 12 + (rng.next() % 50) as u32;
            block(&mut img, x, y, word.min(end - x), line_h, 45);
            x += word + 8 + (rng.next() % 6) as u32;
        }
        y += line_h * 2;
        if y + line_h * 4 > ph {
            break;
        }
    }
    if let Layout::Table = layout {
        let top = ph * 62 / 100;
        for i in 0..=6 {
            block(
                &mut img,
                margin,
                top + i * line_h * 3,
                pw - 2 * margin,
                2,
                60,
            );
        }
        for i in 0..=4 {
            block(
                &mut img,
                margin + i * (pw - 2 * margin) / 4,
                top,
                2,
                line_h * 18,
                60,
            );
        }
    }
    img
}

fn desk_colour(desk: Desk, x: u32, y: u32, rng: &mut Rng) -> [f32; 3] {
    let n = rng.unit();
    match desk {
        Desk::Wood => {
            let grain =
                ((y as f32 / 9.0 + (x as f32 / 140.0).sin() * 3.0).sin() * 0.5 + 0.5) * 30.0;
            [
                120.0 + grain + n * 14.0,
                82.0 + grain * 0.7 + n * 10.0,
                52.0 + grain * 0.4 + n * 8.0,
            ]
        }
        Desk::Granite => {
            let v = 70.0 + n * 60.0;
            [v, v, v + 6.0]
        }
        Desk::Fabric => {
            let v = 38.0 + ((x / 3 + y / 3) % 2) as f32 * 8.0 + n * 10.0;
            [v * 0.8, v * 0.9, v * 1.3]
        }
        Desk::LightGrey => {
            let v = 176.0 + n * 18.0;
            [v, v, v - 4.0]
        }
    }
}

fn render(sample: &Sample) -> RgbImage {
    let mut rng = Rng(sample.seed);
    let (pw, ph) = match sample.layout {
        Layout::Receipt => (500, 1300),
        _ => (850, 1100),
    };
    let doc = page(sample.layout, pw, ph, &mut rng);
    let (fw, fh) = (pw as f32, ph as f32);
    let to_page = Projection::from_control_points(
        sample.corners,
        [(0.0, 0.0), (fw, 0.0), (fw, fh), (0.0, fh)],
    )
    .expect("projection");
    let (strength, sx, sy) = sample.shadow;
    let mut out = RgbImage::new(W, H);
    for y in 0..H {
        for x in 0..W {
            // 3×3 supersampling softens the page edge like a real lens.
            let mut acc = [0.0f32; 3];
            for sy_ in 0..3 {
                for sx_ in 0..3 {
                    let (px, py) = (
                        x as f32 + (sx_ as f32 + 0.5) / 3.0,
                        y as f32 + (sy_ as f32 + 0.5) / 3.0,
                    );
                    let (u, v) = to_page * (px, py);
                    let c = if (0.0..fw).contains(&u) && (0.0..fh).contains(&v) {
                        let g = f32::from(doc.get_pixel(u as u32, v as u32)[0]);
                        [g, g * 0.99, g * 0.96]
                    } else {
                        desk_colour(sample.desk, x, y, &mut rng)
                    };
                    for k in 0..3 {
                        acc[k] += c[k] / 9.0;
                    }
                }
            }
            // Light: brighter towards one side, a soft vignette, sensor noise.
            let (nx, ny) = (x as f32 / W as f32 - 0.5, y as f32 / H as f32 - 0.5);
            let light = 1.0
                - strength * (nx * sx + ny * sy + 0.5).clamp(0.0, 1.0)
                - 0.18 * (nx * nx + ny * ny);
            let noise = (rng.unit() - 0.5) * 10.0;
            out.put_pixel(
                x,
                y,
                Rgb(acc.map(|c| (c * light + noise).clamp(0.0, 255.0) as u8)),
            );
        }
    }
    if sample.blur > 0.0 {
        out = gaussian_blur_f32(&out, sample.blur);
    }
    out
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let dir = std::env::args()
        .nth(1)
        .ok_or("usage: make-samples <output folder>")?;
    std::fs::create_dir_all(&dir)?;
    let samples = [
        Sample {
            name: "letter-wood",
            layout: Layout::Letter,
            desk: Desk::Wood,
            corners: [
                (150.0, 140.0),
                (760.0, 190.0),
                (800.0, 1040.0),
                (95.0, 1010.0),
            ],
            shadow: (0.25, 1.0, 0.3),
            blur: 0.8,
            seed: 11,
        },
        Sample {
            name: "letter-granite-steep",
            layout: Layout::Letter,
            desk: Desk::Granite,
            corners: [
                (250.0, 230.0),
                (650.0, 220.0),
                (860.0, 1130.0),
                (40.0, 1150.0),
            ],
            shadow: (0.35, 0.2, 1.0),
            blur: 1.2,
            seed: 12,
        },
        Sample {
            name: "table-fabric-rotated",
            layout: Layout::Table,
            desk: Desk::Fabric,
            corners: [
                (230.0, 90.0),
                (830.0, 260.0),
                (650.0, 1110.0),
                (60.0, 930.0),
            ],
            shadow: (0.2, -1.0, 0.5),
            blur: 0.6,
            seed: 13,
        },
        Sample {
            name: "table-lightgrey-lowcontrast",
            layout: Layout::Table,
            desk: Desk::LightGrey,
            corners: [
                (110.0, 120.0),
                (790.0, 100.0),
                (820.0, 1080.0),
                (90.0, 1100.0),
            ],
            shadow: (0.15, 0.6, 0.6),
            blur: 1.0,
            seed: 14,
        },
        Sample {
            name: "receipt-wood",
            layout: Layout::Receipt,
            desk: Desk::Wood,
            corners: [
                (300.0, 110.0),
                (610.0, 140.0),
                (580.0, 1120.0),
                (250.0, 1090.0),
            ],
            shadow: (0.3, -0.4, 1.0),
            blur: 0.9,
            seed: 15,
        },
        Sample {
            name: "letter-fabric-shadow",
            layout: Layout::Letter,
            desk: Desk::Fabric,
            corners: [
                (120.0, 200.0),
                (780.0, 150.0),
                (840.0, 1100.0),
                (60.0, 1060.0),
            ],
            shadow: (0.55, 1.0, -0.2),
            blur: 1.4,
            seed: 16,
        },
    ];
    let mut json = String::from("[\n");
    for (i, sample) in samples.iter().enumerate() {
        let photo = render(sample);
        let path = format!("{dir}/{}.jpg", sample.name);
        let mut file = std::io::BufWriter::new(std::fs::File::create(&path)?);
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut file, 85).encode_image(&photo)?;
        let corners = sample
            .corners
            .map(|(x, y)| format!("[{x}, {y}]"))
            .join(", ");
        let comma = if i + 1 < samples.len() { "," } else { "" };
        json.push_str(&format!(
            "  {{ \"file\": \"{}.jpg\", \"corners\": [{corners}] }}{comma}\n",
            sample.name
        ));
        println!("{path}");
    }
    json.push_str("]\n");
    std::fs::write(format!("{dir}/samples.generated.json"), json)?;
    println!("ground truth: {dir}/samples.generated.json (merge into samples.json)");
    Ok(())
}
