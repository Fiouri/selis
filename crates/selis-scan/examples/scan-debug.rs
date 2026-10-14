//! Development aid: finds the page in a photo, prints the corners (photo pixels) and writes
//! `<out>-quad.png` (the outline drawn on the photo) and `<out>-page.png` (straightened, B&W).
//!
//! `cargo run -p selis-scan --example scan-debug --release -- photo.jpg out/prefix`

use image::imageops::{FilterType, resize};
use image::{Rgba, RgbaImage};
use selis_scan::{Filter, Quad, detect, edge_map, grey, output_size, refine, straighten};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = std::env::args().skip(1);
    let (Some(input), Some(out)) = (args.next(), args.next()) else {
        return Err("usage: scan-debug <photo> <output prefix>".into());
    };
    let photo = image::open(&input)?.to_rgba8();
    let scale = 320.0 / photo.width().max(photo.height()) as f32;
    let small = resize(
        &grey(&photo),
        (photo.width() as f32 * scale).round() as u32,
        (photo.height() as f32 * scale).round() as u32,
        FilterType::Triangle,
    );
    edge_map(&small).save(format!("{out}-edges.png"))?;
    let Some(found) = detect(&small) else {
        println!("no page");
        return Ok(());
    };
    let quad = refine(
        &grey(&photo),
        &Quad(found.0.map(|(x, y)| (x / scale, y / scale))),
    );
    println!("{:?}", quad.0.map(|(x, y)| (x.round(), y.round())));
    let mut marked = photo.clone();
    for i in 0..4 {
        let (a, b) = (quad.0[i], quad.0[(i + 1) % 4]);
        draw_line(&mut marked, a, b);
    }
    marked.save(format!("{out}-quad.png"))?;
    let (w, h) = output_size(&quad, 8_000_000);
    if let Some(page) = straighten(&photo, &quad, w, h, Filter::BlackWhite) {
        page.save(format!("{out}-page.png"))?;
    }
    Ok(())
}

fn draw_line(image: &mut RgbaImage, a: (f32, f32), b: (f32, f32)) {
    let steps = (a.0 - b.0).abs().max((a.1 - b.1).abs()).ceil() as u32;
    for s in 0..=steps {
        let t = s as f32 / steps.max(1) as f32;
        let (x, y) = (a.0 + (b.0 - a.0) * t, a.1 + (b.1 - a.1) * t);
        for dx in -2..=2 {
            for dy in -2..=2 {
                let (px, py) = (x as i64 + dx, y as i64 + dy);
                if px >= 0 && py >= 0 && (px as u32) < image.width() && (py as u32) < image.height()
                {
                    image.put_pixel(px as u32, py as u32, Rgba([255, 0, 64, 255]));
                }
            }
        }
    }
}
