//! Scan 2.0 (ADR 0032): the automatic-capture tracker, the touch-up eraser, rotation, the page
//! pipeline and the Enhance filter on generated pages (the stored photos: `samples.rs`).

use super::tests::{TILTED, line_rows, photo};
use super::*;
use crate::live::{AutoCapture, FrameStats, Hint, STEADY_MS};

const PAGE: Quad = Quad([(60.0, 40.0), (200.0, 50.0), (210.0, 260.0), (50.0, 250.0)]);
const SHARP: FrameStats = FrameStats {
    sharpness: 1000.0,
    luma: 120.0,
    area_share: 0.5,
};

fn shifted(q: &Quad, dx: f32) -> Quad {
    Quad(q.0.map(|(x, y)| (x + dx, y)))
}

/// Feeds `frames` frames 66 ms apart from `start`; returns the frame indices that fired.
fn run(
    auto: &mut AutoCapture,
    start: f64,
    frames: u32,
    frame: impl Fn(u32) -> (Option<Quad>, FrameStats),
) -> Vec<u32> {
    (0..frames)
        .filter(|&i| {
            let (q, stats) = frame(i);
            auto.update(q.as_ref(), &stats, start + f64::from(i) * 66.0)
                .fire
        })
        .collect()
}

#[test]
fn auto_fires_once_after_the_steady_time_and_reports_progress() {
    let mut auto = AutoCapture::new();
    let first = auto.update(Some(&PAGE), &SHARP, 0.0);
    assert_eq!(
        (first.progress, first.fire, first.hint),
        (0.0, false, Hint::HoldSteady)
    );
    assert!(!auto.update(Some(&PAGE), &SHARP, 66.0).fire);
    let mid = auto.update(Some(&PAGE), &SHARP, 66.0 + STEADY_MS / 2.0);
    assert!((mid.progress - 0.5).abs() < 0.01, "{mid:?}");
    let fired = auto.update(Some(&PAGE), &SHARP, 66.0 + STEADY_MS);
    assert!(fired.fire && fired.progress == 1.0, "{fired:?}");
    // The same page held longer does not fire again.
    assert!(run(&mut auto, 1000.0, 60, |_| (Some(PAGE), SHARP)).is_empty());
}

#[test]
fn auto_rearms_when_the_page_goes_away_or_after_a_reset() {
    let mut auto = AutoCapture::new();
    assert_eq!(run(&mut auto, 0.0, 15, |_| (Some(PAGE), SHARP)).len(), 1);
    // The page is lifted (three frames without it), a new one is put down.
    assert!(run(&mut auto, 1000.0, 3, |_| (None, SHARP)).is_empty());
    assert_eq!(run(&mut auto, 1200.0, 15, |_| (Some(PAGE), SHARP)).len(), 1);
    // Moved far (a new page in another place) re-arms as well.
    let moved = shifted(&PAGE, 40.0);
    assert_eq!(
        run(&mut auto, 2200.0, 15, |_| (Some(moved), SHARP)).len(),
        1
    );
    auto.reset();
    assert_eq!(
        run(&mut auto, 3200.0, 15, |_| (Some(moved), SHARP)).len(),
        1
    );
}

#[test]
fn auto_does_not_fire_on_a_drifting_or_blurred_outline() {
    let mut auto = AutoCapture::new();
    // About 3 % of the diagonal (~210 px) per frame.
    let drifting = run(&mut auto, 0.0, 40, |i| {
        (Some(shifted(&PAGE, i as f32 * 6.5)), SHARP)
    });
    assert!(drifting.is_empty(), "{drifting:?}");
    let blurred = FrameStats {
        sharpness: 100.0,
        ..SHARP
    };
    let mut auto = AutoCapture::new();
    assert!(run(&mut auto, 0.0, 40, |_| (Some(PAGE), blurred)).is_empty());
    assert_eq!(
        auto.update(Some(&PAGE), &blurred, 3000.0).hint,
        Hint::HoldSteady
    );
}

#[test]
fn auto_forgives_one_missed_frame_or_one_snapped_corner() {
    let mut auto = AutoCapture::new();
    let mut snapped = PAGE;
    snapped.0[2] = (200.0, 270.0);
    let fired = run(&mut auto, 0.0, 15, |i| match i {
        4 => (None, SHARP),
        7 => (Some(snapped), SHARP),
        _ => (Some(PAGE), SHARP),
    });
    assert_eq!(fired.len(), 1, "{fired:?}");
    assert!(fired[0] <= 11, "{fired:?}");
}

#[test]
fn hints_follow_the_frame() {
    let mut auto = AutoCapture::new();
    let dark = FrameStats {
        luma: 30.0,
        ..SHARP
    };
    assert_eq!(auto.update(None, &dark, 0.0).hint, Hint::MoreLight);
    assert_eq!(auto.update(None, &SHARP, 66.0).hint, Hint::FindPage);
    let far = FrameStats {
        area_share: 0.2,
        ..SHARP
    };
    assert_eq!(auto.update(Some(&PAGE), &far, 132.0).hint, Hint::MoveCloser);
    assert_eq!(auto.update(Some(&PAGE), &dark, 198.0).hint, Hint::MoreLight);
}

#[test]
fn frame_measures() {
    let flat = GrayImage::from_pixel(100, 80, Luma([90]));
    let quad = Quad([(10.0, 10.0), (90.0, 10.0), (90.0, 70.0), (10.0, 70.0)]);
    let stats = live::frame_stats(&flat, Some(&quad));
    assert_eq!(stats.sharpness, 0.0);
    assert!((stats.luma - 90.0).abs() < 0.01);
    assert!((stats.area_share - 0.6).abs() < 0.001);
    let checker = GrayImage::from_fn(100, 80, |x, y| {
        Luma([if (x + y) % 2 == 0 { 0 } else { 255 }])
    });
    assert!(live::sharpness(&checker, &quad) > 100_000.0);
}

#[test]
fn eraser_fills_a_mark_with_the_paper_around_it() {
    // Grey-blue paper with a dark diagonal pen line.
    let mut page = RgbaImage::from_fn(200, 200, |x, y| {
        if x.abs_diff(y) <= 2 && (40..160).contains(&x) {
            Rgba([20, 20, 120, 255])
        } else {
            Rgba([200, 210, 220, 255])
        }
    });
    let stroke = Stroke {
        radius: 6.0,
        points: vec![(40.0, 40.0), (100.0, 100.0), (160.0, 160.0)],
    };
    touchup::erase(&mut page, &[stroke]);
    for i in 40..160 {
        assert_eq!(page.get_pixel(i, i).0, [200, 210, 220, 255], "at {i}");
    }
    // Paper away from the stroke is untouched.
    assert_eq!(page.get_pixel(150, 20).0, [200, 210, 220, 255]);
}

#[test]
fn rotate_turns_clockwise() {
    let mut image = RgbaImage::from_pixel(4, 2, Rgba([255, 255, 255, 255]));
    image.put_pixel(0, 0, Rgba([0, 0, 0, 255]));
    let once = rotate(image.clone(), 1);
    assert_eq!(once.dimensions(), (2, 4));
    // The top-left pixel goes to the top-right.
    assert_eq!(once.get_pixel(1, 0).0, [0, 0, 0, 255]);
    assert_eq!(rotate(image.clone(), 4), image);
    assert_eq!(rotate(rotate(image.clone(), 3), 1), image);
}

#[test]
fn render_applies_filter_touch_ups_and_rotation() {
    let image = photo(960, 1280, TILTED, 21);
    let quad = Quad(TILTED);
    let plain = Edits {
        filter: Filter::Grey,
        strokes: Vec::new(),
        quarter_turns: 0,
    };
    let page = render(&image, &quad, 600_000, &plain).expect("render");
    let ink = |p: &RgbaImage, y: u32| {
        (p.width() / 4..p.width() * 3 / 4)
            .filter(|&x| p.get_pixel(x, y)[0] < 110)
            .count()
    };
    let first = line_rows(&grey(&page), page.width() / 2)[0];
    assert!(ink(&page, first + 1) > 0);
    // A stroke along the first text line wipes it.
    let y = (first + 1) as f32 / page.height() as f32;
    let wiped = Edits {
        filter: Filter::Grey,
        strokes: vec![RelativeStroke {
            radius: 0.02,
            points: vec![(0.05, y), (0.95, y)],
        }],
        quarter_turns: 0,
    };
    let clean = render(&image, &quad, 600_000, &wiped).expect("render");
    assert_eq!(ink(&clean, first + 1), 0);
    let turned = render(
        &image,
        &quad,
        600_000,
        &Edits {
            quarter_turns: 1,
            ..wiped
        },
    )
    .expect("render");
    assert_eq!(turned.dimensions(), (page.height(), page.width()));
}

#[test]
fn enhance_evens_out_falling_light() {
    let image = photo(960, 1280, TILTED, 23);
    let quad = Quad(TILTED);
    let (w, h) = output_size(&quad, 1_000_000);
    let page = grey(&straighten(&image, &quad, w, h, Filter::Enhance).expect("warp"));
    // Blank margin near the top and the bottom: the same white despite the falloff.
    let margin = |y: u32| {
        (w * 3 / 100..w * 7 / 100)
            .map(|x| u32::from(page.get_pixel(x, y)[0]))
            .sum::<u32>()
            / (w * 7 / 100 - w * 3 / 100)
    };
    let (top, bottom) = (margin(h / 20), margin(h * 19 / 20));
    assert!(top >= 245 && bottom >= 245, "top {top}, bottom {bottom}");
    // The text lines are all still there.
    assert_eq!(line_rows(&page, w / 2).len(), 11);
}
