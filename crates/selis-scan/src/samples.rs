//! The stored sample photos (`packages/fixtures/scan`, ADR 0016): the page is found near its
//! ground-truth corners and the straightened page is not tilted.

use std::path::PathBuf;

use super::*;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/fixtures/scan")
}

struct Sample {
    file: String,
    corners: [(f32, f32); 4],
}

fn samples() -> Vec<Sample> {
    let text = std::fs::read_to_string(fixtures().join("samples.json")).expect("samples.json");
    let list: serde_json::Value = serde_json::from_str(&text).expect("json");
    list.as_array()
        .expect("array")
        .iter()
        .map(|s| {
            let c = s["corners"].as_array().expect("corners");
            let point = |i: usize| {
                (
                    c[i][0].as_f64().expect("x") as f32,
                    c[i][1].as_f64().expect("y") as f32,
                )
            };
            Sample {
                file: s["file"].as_str().expect("file").to_owned(),
                corners: [point(0), point(1), point(2), point(3)],
            }
        })
        .collect()
}

/// The skew (degrees) of the dark marks (below mid-grey) of a straightened page: the shear that lines up the
/// most dark pixels in rows (a projection profile), searched over ±4° in 0.1° steps.
fn skew_degrees(page: &GrayImage) -> f32 {
    let dark: Vec<(f32, f32)> = page
        .enumerate_pixels()
        .filter(|(_, _, p)| p[0] < 100)
        .map(|(x, y, _)| (x as f32, y as f32))
        .collect();
    let h = page.height() as usize;
    let mut best = (0.0f32, 0u64);
    for step in -40..=40 {
        let deg = step as f32 / 10.0;
        let t = deg.to_radians().tan();
        let mut rows = vec![0u64; h * 2];
        for (x, y) in &dark {
            let r = (y + x * t + h as f32 / 2.0).round();
            if r >= 0.0 && (r as usize) < rows.len() {
                rows[r as usize] += 1;
            }
        }
        let score: u64 = rows.iter().map(|c| c * c).sum();
        if score > best.1 {
            best = (deg, score);
        }
    }
    best.0
}

#[test]
fn every_stored_photo_is_found_and_straightened() {
    let list = samples();
    assert!(list.len() >= 7, "{} samples", list.len());
    for sample in list {
        let photo = image::open(fixtures().join(&sample.file))
            .expect("photo")
            .to_rgba8();
        let quad =
            find_page(&grey(&photo)).unwrap_or_else(|| panic!("{}: no page found", sample.file));
        // Corners within 1 % of the photo's diagonal (15–18 px here).
        let tolerance = (photo.width() as f32).hypot(photo.height() as f32) * 0.01;
        for (f, e) in quad.0.iter().zip(sample.corners) {
            assert!(
                dist(*f, e) <= tolerance,
                "{}: corner {f:?} is {:.1} px from {e:?}",
                sample.file,
                dist(*f, e)
            );
        }
        let (w, h) = output_size(&quad, 1_000_000);
        let page = grey(&straighten(&photo, &quad, w, h, Filter::Grey).expect("warp"));
        let skew = skew_degrees(&page);
        let worst = quad
            .0
            .iter()
            .zip(sample.corners)
            .map(|(f, e)| dist(*f, e))
            .fold(0.0, f32::max);
        println!("{}: worst corner {worst:.1} px, skew {skew}°", sample.file);
        assert!(
            skew.abs() <= 0.3,
            "{}: straightened page is tilted {skew}°",
            sample.file
        );
    }
}

#[test]
fn a_tilted_page_measures_as_tilted() {
    // The skew measure itself: the same page straightened from corners rotated by ~2°.
    let sample = &samples()[0];
    let photo = image::open(fixtures().join(&sample.file))
        .expect("photo")
        .to_rgba8();
    let [tl, tr, br, bl] = sample.corners;
    let lift = dist(tl, tr) * 2f32.to_radians().tan();
    let quad = Quad([(tl.0, tl.1 + lift), tr, (br.0, br.1 - lift), bl]);
    let (w, h) = output_size(&quad, 1_000_000);
    let page = grey(&straighten(&photo, &quad, w, h, Filter::BlackWhite).expect("warp"));
    assert!(skew_degrees(&page).abs() >= 1.0);
}
