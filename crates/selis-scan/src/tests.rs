use super::*;

/// A deterministic pseudo-random sequence (xorshift), for textured backgrounds.
struct Noise(u32);

impl Noise {
    fn next(&mut self) -> u32 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 17;
        self.0 ^= self.0 << 5;
        self.0
    }
}

/// A flat page (white, with dark text lines every 1/12 of its height) seen through `quad` on
/// a darker, textured desk. Returns the RGBA photo.
fn photo(w: u32, h: u32, quad: [(f32, f32); 4], seed: u32) -> RgbaImage {
    let (pw, ph) = (850.0f32, 1100.0f32);
    // Maps photo pixels back onto the page.
    let to_page =
        Projection::from_control_points(quad, [(0.0, 0.0), (pw, 0.0), (pw, ph), (0.0, ph)])
            .expect("projection");
    let mut noise = Noise(seed | 1);
    RgbaImage::from_fn(w, h, |x, y| {
        let (u, v) = to_page * (x as f32 + 0.5, y as f32 + 0.5);
        let grain = (noise.next() % 24) as u8;
        if (0.0..pw).contains(&u) && (0.0..ph).contains(&v) {
            let line = (v / ph * 12.0).fract();
            let ink = u > pw * 0.1 && u < pw * 0.9 && v > ph * 0.08 && line < 0.06;
            let shade = 230 - (v / ph * 30.0) as u8; // light falls off down the page
            let c = if ink { 40 } else { shade };
            Rgba([c, c, c.saturating_sub(4), 255])
        } else {
            let wood = 70 + ((x / 7 + y / 23) % 3) as u8 * 6 + grain;
            Rgba([wood + 20, wood + 8, wood, 255])
        }
    })
}

fn small_grey(image: &RgbaImage, long_side: u32) -> (GrayImage, f32) {
    let scale = long_side as f32 / image.width().max(image.height()) as f32;
    let (w, h) = (
        (image.width() as f32 * scale).round() as u32,
        (image.height() as f32 * scale).round() as u32,
    );
    let small = image::imageops::resize(&grey(image), w, h, image::imageops::FilterType::Triangle);
    (small, scale)
}

fn assert_close(found: &Quad, expected: [(f32, f32); 4], tolerance: f32) {
    for (f, e) in found.0.iter().zip(expected) {
        assert!(
            dist(*f, e) <= tolerance,
            "corner {f:?} is more than {tolerance} px from {e:?} (found {found:?})"
        );
    }
}

const TILTED: [(f32, f32); 4] = [
    (210.0, 120.0),
    (790.0, 170.0),
    (860.0, 1020.0),
    (150.0, 1060.0),
];

#[test]
fn finds_a_tilted_page_on_a_desk() {
    let image = photo(960, 1280, TILTED, 7);
    let (small, scale) = small_grey(&image, 320);
    let quad = detect(&small).expect("a page");
    let expected = TILTED.map(|(x, y)| (x * scale, y * scale));
    assert_close(&quad, expected, 4.0);
}

#[test]
fn finds_a_page_in_strong_perspective() {
    let corners = [
        (330.0, 260.0),
        (650.0, 250.0),
        (900.0, 1150.0),
        (80.0, 1170.0),
    ];
    let image = photo(960, 1280, corners, 11);
    let (small, scale) = small_grey(&image, 320);
    let quad = detect(&small).expect("a page");
    assert_close(&quad, corners.map(|(x, y)| (x * scale, y * scale)), 4.0);
}

#[test]
fn finds_nothing_on_an_empty_desk() {
    let image = RgbaImage::from_fn(320, 240, |x, y| {
        let v = 70 + ((x / 7 + y / 23) % 3) as u8 * 6;
        Rgba([v, v, v, 255])
    });
    assert_eq!(detect(&grey(&image)), None);
}

#[test]
fn ignores_a_small_card() {
    let corners = [
        (400.0, 500.0),
        (560.0, 505.0),
        (555.0, 640.0),
        (398.0, 636.0),
    ];
    let image = photo(960, 1280, corners, 3);
    let (small, _) = small_grey(&image, 320);
    assert_eq!(detect(&small), None);
}

#[test]
fn orders_corners_clockwise_from_top_left() {
    let shuffled = [(10.0, 90.0), (95.0, 5.0), (5.0, 8.0), (90.0, 95.0)];
    assert_eq!(
        order(shuffled).0,
        [(5.0, 8.0), (95.0, 5.0), (90.0, 95.0), (10.0, 90.0)]
    );
}

#[test]
fn output_size_follows_the_longer_sides_and_the_cap() {
    let quad = Quad([(0.0, 0.0), (1000.0, 0.0), (900.0, 1400.0), (100.0, 1400.0)]);
    assert_eq!(output_size(&quad, u64::MAX), (1000, 1404));
    let (w, h) = output_size(&quad, 350_000);
    assert!(u64::from(w) * u64::from(h) <= 350_000 + 2000, "{w}×{h}");
    assert!((w as f32 / h as f32 - 1000.0 / 1404.0).abs() < 0.01);
}

/// Rows of the straightened page where the text lines are, measured at its left and right
/// ends: a straight page has each line at the same height on both sides.
fn line_rows(page: &GrayImage, x: u32) -> Vec<u32> {
    let mut rows = Vec::new();
    let mut inside = false;
    for y in 0..page.height() {
        let dark = (x.saturating_sub(3)..=(x + 3).min(page.width() - 1))
            .filter(|&xx| page.get_pixel(xx, y)[0] < 110)
            .count()
            >= 4;
        if dark && !inside {
            rows.push(y);
        }
        inside = dark;
    }
    rows
}

#[test]
fn straightened_page_is_straight() {
    let image = photo(960, 1280, TILTED, 5);
    let (small, scale) = small_grey(&image, 320);
    let found = detect(&small).expect("a page");
    let quad = Quad(found.0.map(|(x, y)| (x / scale, y / scale)));
    let (w, h) = output_size(&quad, 4_000_000);
    for filter in [Filter::Original, Filter::Grey, Filter::BlackWhite] {
        let page = straighten(&image, &quad, w, h, filter).expect("warp");
        let g = grey(&page);
        let left = line_rows(&g, w * 15 / 100);
        let right = line_rows(&g, w * 85 / 100);
        assert_eq!(left.len(), 11, "{filter:?}: lines on the left {left:?}");
        assert_eq!(right.len(), 11, "{filter:?}: lines on the right {right:?}");
        // Within 0.6% of the page height (a few px at this size): not tilted, not bowed.
        let tolerance = (h as f32 * 0.006).ceil() as i64;
        for (l, r) in left.iter().zip(&right) {
            assert!(
                (i64::from(*l) - i64::from(*r)).abs() <= tolerance,
                "{filter:?}: line at {l} on the left is at {r} on the right"
            );
        }
    }
}

#[test]
fn black_and_white_drops_the_shading() {
    let image = photo(960, 1280, TILTED, 9);
    let quad = Quad(TILTED);
    let (w, h) = output_size(&quad, 4_000_000);
    let page = grey(&straighten(&image, &quad, w, h, Filter::BlackWhite).expect("warp"));
    assert!(page.pixels().all(|p| p[0] == 0 || p[0] == 255));
    // Paper (a blank margin band) is white at the top and at the bottom despite the falloff.
    for y in [h / 20, h * 19 / 20] {
        let white = (w / 4..w * 3 / 4)
            .filter(|&x| page.get_pixel(x, y)[0] == 255)
            .count() as u32;
        assert!(white > w / 2 * 95 / 100, "row {y}: {white} white");
    }
}

#[test]
fn filters_by_code() {
    assert_eq!(Filter::from_code(0), Some(Filter::Original));
    assert_eq!(Filter::from_code(2), Some(Filter::BlackWhite));
    assert_eq!(Filter::from_code(3), None);
}

#[test]
fn inset_moves_every_side_inwards() {
    let q = inset(
        &Quad([(0.0, 0.0), (100.0, 0.0), (100.0, 50.0), (0.0, 50.0)]),
        2.0,
    );
    assert_close(
        &q,
        [(2.0, 2.0), (98.0, 2.0), (98.0, 48.0), (2.0, 48.0)],
        0.01,
    );
}
