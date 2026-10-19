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

/// The scan-sample corpus: the stored photos and the store's sample photo (en, el).
fn corpus() -> Vec<PathBuf> {
    let store = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../docs/store/scan-sample");
    let mut files: Vec<PathBuf> = samples().iter().map(|s| fixtures().join(&s.file)).collect();
    files.push(store.join("en.jpg"));
    files.push(store.join("el.jpg"));
    files
}

fn name(path: &std::path::Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A photo as the live loop sees it: grey, `DETECT_SIZE` px on the long side, scaled the way
/// the WebView's `drawImage` scales a video frame (bilinear sampling, no area averaging).
fn detection_frame(path: &std::path::Path) -> GrayImage {
    let g = grey(&image::open(path).expect("photo").to_rgba8());
    let scale = DETECT_SIZE as f32 / g.width().max(g.height()) as f32;
    let (w, h) = (
        (g.width() as f32 * scale).round() as u32,
        (g.height() as f32 * scale).round() as u32,
    );
    let mut small = GrayImage::new(w, h);
    warp_into(
        &g,
        Projection::scale(scale, scale) * Projection::translate(-0.5, -0.5),
        Interpolation::Bilinear,
        Border::Replicate,
        &mut small,
    );
    small
}

/// Frame `i` of a 15 fps "video" of `still`: shifted by `offset` px (sub-pixel, bilinear) with
/// a little sensor noise, optionally out of focus (Gaussian blur `blur` px).
fn video_frame(still: &GrayImage, i: u32, offset: (f32, f32), blur: f32) -> GrayImage {
    let mut frame = GrayImage::new(still.width(), still.height());
    warp_into(
        still,
        Projection::translate(offset.0, offset.1),
        Interpolation::Bilinear,
        Border::Replicate,
        &mut frame,
    );
    let mut noise = i.wrapping_mul(2_654_435_761) | 1;
    for p in frame.pixels_mut() {
        noise ^= noise << 13;
        noise ^= noise >> 17;
        noise ^= noise << 5;
        p.0[0] = p.0[0].saturating_add((noise % 5) as u8).saturating_sub(2);
    }
    if blur > 0.0 {
        gaussian_blur_f32(&frame, blur)
    } else {
        frame
    }
}

const FRAME_MS: f64 = 1000.0 / 15.0;

/// Replays `frames` frames of `still` through detection and the tracker as `scan_live` does;
/// returns the times (ms) it fired at.
fn replay(
    still: &GrayImage,
    frames: u32,
    offset: impl Fn(u32) -> (f32, f32),
    blur: f32,
) -> Vec<f64> {
    let mut auto = live::AutoCapture::new();
    let mut fired = Vec::new();
    for i in 0..frames {
        let frame = video_frame(still, i, offset(i), blur);
        let found = detect_scored(&frame);
        let stats = live::frame_stats(&frame, found.as_ref().map(|(q, s)| (q, *s)));
        let quad = found.map(|(q, _)| q);
        let now = f64::from(i) * FRAME_MS;
        if auto.update(quad.as_ref(), &stats, now).fire {
            fired.push(now);
        }
    }
    fired
}

/// A hand holding still: a fraction of a pixel of tremor.
fn tremor(i: u32) -> (f32, f32) {
    let t = i as f32;
    ((t * 1.7).sin() * 0.4, (t * 2.3).cos() * 0.4)
}

#[test]
fn sharpness_threshold_separates_sharp_and_out_of_focus_frames() {
    let measured: Vec<(String, f32, f32, f32)> = corpus()
        .iter()
        .map(|path| {
            let frame = detection_frame(path);
            let quad =
                detect(&frame).unwrap_or_else(|| panic!("{}: no page in the frame", name(path)));
            let soft = |sigma| live::sharpness(&gaussian_blur_f32(&frame, sigma), &quad);
            (
                name(path),
                live::sharpness(&frame, &quad),
                soft(1.5),
                soft(2.0),
            )
        })
        .collect();
    for (file, sharp, soft, softer) in &measured {
        println!("{file}: sharpness {sharp:.0}, out of focus {soft:.0} (σ 1.5), {softer:.0} (σ 2)");
    }
    for (file, sharp, soft, _) in &measured {
        assert!(
            *sharp >= live::SHARPNESS_MIN * 2.0,
            "{file}: sharp frame measures {sharp}"
        );
        assert!(
            *soft <= live::SHARPNESS_MIN / 2.0,
            "{file}: blurred frame measures {soft}"
        );
    }
}

#[test]
fn auto_capture_fires_on_the_samples_replayed_as_video() {
    for path in corpus() {
        let still = detection_frame(&path);
        // Three seconds of a steady hand.
        let fired = replay(&still, 45, tremor, 0.0);
        println!("{}: fired at {fired:?} ms", name(&path));
        let first = *fired
            .first()
            .unwrap_or_else(|| panic!("{}: never fired", name(&path)));
        // Steady time plus a few frames where clutter snapped a corner (the emulator's TV
        // stand) or the outline was missed.
        assert!(
            (live::STEADY_MS..=2000.0).contains(&first),
            "{}: fired at {first} ms",
            name(&path)
        );
        // Once: the same page is not captured again.
        assert_eq!(fired.len(), 1, "{}: fired {fired:?}", name(&path));
    }
}

#[test]
fn auto_capture_does_not_fire_on_blurred_frames() {
    for path in corpus() {
        let still = detection_frame(&path);
        let fired = replay(&still, 45, tremor, 1.5);
        assert!(
            fired.is_empty(),
            "{}: fired at {fired:?} on blurred frames",
            name(&path)
        );
    }
}

#[test]
fn auto_capture_does_not_fire_while_the_camera_moves() {
    for path in corpus() {
        let still = detection_frame(&path);
        let quad = detect(&still).expect("a page");
        // A pan back and forth by 3 % of the page's diagonal per frame.
        let [tl, tr, br, bl] = quad.0;
        let diagonal = (dist(tl, br) + dist(tr, bl)) / 2.0;
        let step = diagonal * 0.03;
        let pan = |i: u32| {
            let phase = i % 8;
            let k = if phase < 4 { phase } else { 8 - phase };
            (k as f32 * step - 2.0 * step, 0.0)
        };
        let fired = replay(&still, 45, pan, 0.0);
        assert!(
            fired.is_empty(),
            "{}: fired at {fired:?} while moving",
            name(&path)
        );
    }
}

/// Luma standard deviation over the page's blank side margins, and the mean ink/paper contrast
/// of the text area (per 32 px tile with ink: 95th − 5th luma percentile).
fn page_measures(page: &RgbaImage) -> (f32, f32) {
    let g = grey(page);
    let (w, h) = g.dimensions();
    let (mut sum, mut sum_sq, mut n) = (0f64, 0f64, 0f64);
    for y in h * 3 / 100..h * 97 / 100 {
        for x in (w * 2 / 100..w * 7 / 100).chain(w * 93 / 100..w * 98 / 100) {
            let v = f64::from(g.get_pixel(x, y)[0]);
            sum += v;
            sum_sq += v * v;
            n += 1.0;
        }
    }
    let mean = sum / n;
    let std = (sum_sq / n - mean * mean).max(0.0).sqrt() as f32;
    let (mut contrast, mut tiles) = (0f32, 0f32);
    let tile = 32;
    let mut y = h / 10;
    while y + tile < h * 9 / 10 {
        let mut x = w * 12 / 100;
        while x + tile < w * 88 / 100 {
            let mut values: Vec<u8> = (y..y + tile)
                .flat_map(|yy| (x..x + tile).map(move |xx| (xx, yy)))
                .map(|(xx, yy)| g.get_pixel(xx, yy)[0])
                .collect();
            values.sort_unstable();
            let lo = values[values.len() * 5 / 100];
            let hi = values[values.len() * 95 / 100];
            if hi.saturating_sub(lo) > 40 {
                contrast += f32::from(hi - lo);
                tiles += 1.0;
            }
            x += tile;
        }
        y += tile;
    }
    (std, contrast / tiles.max(1.0))
}

/// The stored photos made with uneven light (`make-samples.rs` shadow strength ≥ 0.3).
const SHADOWED: [&str; 3] = [
    "letter-granite-steep.jpg",
    "receipt-wood.jpg",
    "letter-fabric-shadow.jpg",
];

#[test]
fn enhance_removes_shadows_and_keeps_text_contrast() {
    for sample in samples() {
        if sample.file.starts_with("avd-") {
            continue;
        }
        let photo = image::open(fixtures().join(&sample.file))
            .expect("photo")
            .to_rgba8();
        let quad = Quad(sample.corners);
        let (w, h) = output_size(&quad, 2_000_000);
        let original = straighten(&photo, &quad, w, h, Filter::Original).expect("warp");
        let enhanced = straighten(&photo, &quad, w, h, Filter::Enhance).expect("warp");
        let (std_o, contrast_o) = page_measures(&original);
        let (std_e, contrast_e) = page_measures(&enhanced);
        let drop = 1.0 - std_e / std_o;
        println!(
            "{}: background std-dev {std_o:.1} → {std_e:.1} (−{:.0} %), text contrast {contrast_o:.0} → {contrast_e:.0}",
            sample.file,
            drop * 100.0
        );
        if SHADOWED.contains(&sample.file.as_str()) {
            assert!(
                drop >= 0.5,
                "{}: background std-dev dropped only {:.0} %",
                sample.file,
                drop * 100.0
            );
        }
        assert!(
            contrast_e >= contrast_o,
            "{}: text contrast fell from {contrast_o} to {contrast_e}",
            sample.file
        );
    }
}

#[test]
fn steady_samples_are_found_with_auto_keep_support() {
    // Batch mode keeps an automatic capture without the Adjust step only above
    // `AUTO_KEEP_SUPPORT`; every photo of the corpus, held steady, gets there.
    for path in corpus() {
        let frame = detection_frame(&path);
        let (_, support) =
            detect_scored(&frame).unwrap_or_else(|| panic!("{}: no page", name(&path)));
        println!("{}: edge support {support:.2}", name(&path));
        assert!(
            support >= live::AUTO_KEEP_SUPPORT,
            "{}: support {support}",
            name(&path)
        );
    }
}
