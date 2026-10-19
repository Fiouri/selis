//! Live-frame measurements and automatic capture (Scan 2.0, ADR 0032). Runs on every detection
//! frame (about 320 px on the long side, at most 15 a second), so nothing here allocates: the
//! sharpness is summed in place and the tracker keeps a fixed amount of state.

use image::GrayImage;

use crate::Quad;

/// What a live frame says besides the outline.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct FrameStats {
    /// Variance of the Laplacian over the outline's bounding box (the page and its edges):
    /// high when the frame is in focus and still, low when blurred.
    pub sharpness: f32,
    /// Mean luma of the whole frame, 0–255.
    pub luma: f32,
    /// The outline's area as a share of the frame (0 without an outline).
    pub area_share: f32,
    /// How well the outline sits on edges: the share of its weakest side's middle 80 % on edge
    /// pixels (0 without an outline).
    pub support: f32,
}

/// Mean luma of a grey frame.
#[must_use]
pub fn mean_luma(gray: &GrayImage) -> f32 {
    let total: u64 = gray.as_raw().iter().map(|v| u64::from(*v)).sum();
    let n = gray.as_raw().len().max(1);
    total as f32 / n as f32
}

/// Variance of the 4-neighbour Laplacian over the bounding box of `quad` (clipped to the frame,
/// at least 8 px from the frame's edge so the kernel stays inside). 0 for an empty box.
#[must_use]
pub fn sharpness(gray: &GrayImage, quad: &Quad) -> f32 {
    let (w, h) = gray.dimensions();
    if w < 3 || h < 3 {
        return 0.0;
    }
    let xs = quad.0.map(|p| p.0);
    let ys = quad.0.map(|p| p.1);
    let clip = |v: f32, hi: u32| (v.max(1.0) as u32).min(hi - 2);
    let x0 = clip(xs.iter().copied().fold(f32::MAX, f32::min), w);
    let x1 = clip(xs.iter().copied().fold(f32::MIN, f32::max), w);
    let y0 = clip(ys.iter().copied().fold(f32::MAX, f32::min), h);
    let y1 = clip(ys.iter().copied().fold(f32::MIN, f32::max), h);
    if x1 <= x0 || y1 <= y0 {
        return 0.0;
    }
    let raw = gray.as_raw();
    let stride = w as usize;
    let (mut sum, mut sum_sq, mut n) = (0f64, 0f64, 0u64);
    for y in y0..=y1 {
        let row = y as usize * stride;
        for x in x0..=x1 {
            let i = row + x as usize;
            let lap = i32::from(raw[i - 1])
                + i32::from(raw[i + 1])
                + i32::from(raw[i - stride])
                + i32::from(raw[i + stride])
                - 4 * i32::from(raw[i]);
            let lap = f64::from(lap);
            sum += lap;
            sum_sq += lap * lap;
            n += 1;
        }
    }
    let n = n as f64;
    let mean = sum / n;
    (sum_sq / n - mean * mean).max(0.0) as f32
}

/// The measurements of a grey live frame and its outline (with the outline's edge support,
/// from `detect_scored`).
#[must_use]
pub fn frame_stats(gray: &GrayImage, found: Option<(&Quad, f32)>) -> FrameStats {
    FrameStats {
        sharpness: found.map_or(0.0, |(q, _)| sharpness(gray, q)),
        luma: mean_luma(gray),
        area_share: found.map_or(0.0, |(q, _)| area_share(q, gray.width(), gray.height())),
        support: found.map_or(0.0, |(_, s)| s),
    }
}

/// Edge support an automatic capture needs to keep the page without the Adjust step (batch
/// mode, ADR 0032): every side on edge pixels for at least 85 % of its middle 80 % — stricter
/// than the 70 % a found outline needs.
pub const AUTO_KEEP_SUPPORT: f32 = 0.85;

/// The share of a `width × height` frame that `quad` covers.
#[must_use]
pub fn area_share(quad: &Quad, width: u32, height: u32) -> f32 {
    let p = quad.0;
    let twice: f32 = (0..4)
        .map(|i| {
            let (a, b) = (p[i], p[(i + 1) % 4]);
            a.0 * b.1 - b.0 * a.1
        })
        .sum();
    (twice.abs() / 2.0) / (width as f32 * height as f32).max(1.0)
}

/// Sharpness (variance of the Laplacian, 320 px frames) a frame needs before it is captured
/// automatically. Calibrated on the scan-sample corpus (`packages/fixtures/scan`,
/// `docs/store/scan-sample`; `samples.rs` checks it) scaled to detection frames the way the
/// WebView's `drawImage` scales the camera preview (bilinear, no area averaging): every photo
/// measures 2 699–7 590; the same frames out of focus (Gaussian blur σ 1.5 px at 320 px, about
/// 9 px on the 1080p preview) at most 256. The threshold sits ~3× from both.
pub const SHARPNESS_MIN: f32 = 800.0;
/// How long the outline must hold still, ms.
pub const STEADY_MS: f64 = 600.0;
/// Most a corner may move between consecutive frames, as a share of the page's diagonal.
pub const MAX_DRIFT: f32 = 0.02;
/// After a capture, the next one waits until the outline has been gone this long (ms; a page
/// is lifted and another put down — a few frames lost to glare or a slow frame are not that)…
const REARM_LOST_MS: f64 = 1000.0;
/// …or has moved this share of its diagonal away from the captured outline (a new page put
/// down elsewhere; a corner snapping to clutter moves less), measured on a full median.
const REARM_DRIFT: f32 = 0.25;
/// An outline smaller than this share of the frame is far away: "Move closer" (it is still
/// captured when steady; a small page is a page).
pub const MIN_AREA_SHARE: f32 = 0.35;
/// A frame darker than this mean luma needs more light ("More light", offer the torch).
pub const DARK_LUMA: f32 = 60.0;

/// A hint for the person holding the camera, in order of priority.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Hint {
    None = 0,
    /// No outline: point the camera at a page.
    FindPage = 1,
    MoreLight = 2,
    MoveCloser = 3,
    HoldSteady = 4,
}

/// The tracker's answer for one frame.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Verdict {
    /// How far through the steady time the outline is, 0–1 (0 when not armed or not steady).
    pub progress: f32,
    /// Capture now (once per armed outline).
    pub fire: bool,
    pub hint: Hint,
}

/// Decides when a live outline is steady and sharp enough to capture by itself: its corners
/// have moved less than `MAX_DRIFT` of its diagonal between consecutive frames for
/// `STEADY_MS`, and the frame is sharp. The corners compared are each the median of the last
/// three detections (one frame where a corner snaps to clutter does not break a steady
/// outline), and one frame without an outline is forgiven. After firing it stays quiet until
/// the page changes (the outline is lost for a few frames or moves far), so a kept page is not
/// captured again.
#[derive(Clone, Copy, Debug, Default)]
pub struct AutoCapture {
    /// The last detections (a ring), `filled` of them valid.
    history: [Quad; HISTORY],
    filled: usize,
    next: usize,
    /// The previous frame's median outline.
    previous: Option<Quad>,
    steady_since: Option<f64>,
    /// The outline last captured, while waiting for the page to change.
    fired: Option<Quad>,
    misses: u32,
    /// When the outline was last seen (ms), for the time it has been gone.
    last_seen: Option<f64>,
    /// The camera has just (re)started: frames without an outline do not count as the page
    /// going away until an outline has been seen again.
    resuming: bool,
}

/// Detections the median is taken over.
const HISTORY: usize = 3;
/// Frames without an outline that do not interrupt a steady one.
const GRACE_MISSES: u32 = 1;
/// The drift allowance never goes below this (corners of a 320 px frame land on whole pixels).
const MIN_DRIFT_PX: f32 = 1.5;

/// The mean of a quad's two diagonals.
fn diagonal(q: &Quad) -> f32 {
    let p = q.0;
    let d = |a: (f32, f32), b: (f32, f32)| (a.0 - b.0).hypot(a.1 - b.1);
    (d(p[0], p[2]) + d(p[1], p[3])) / 2.0
}

/// The largest distance a corner moved between `a` and `b`.
fn drift(a: &Quad, b: &Quad) -> f32 {
    (0..4)
        .map(|i| (a.0[i].0 - b.0[i].0).hypot(a.0[i].1 - b.0[i].1))
        .fold(0.0, f32::max)
}

/// The median of up to three values (the mean of two).
fn median(values: &[f32]) -> f32 {
    match *values {
        [a] => a,
        [a, b] => (a + b) / 2.0,
        [a, b, c] => a.max(b).min(a.min(b).max(c)),
        _ => 0.0,
    }
}

impl AutoCapture {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Forgets everything (camera reopened, Retake, Auto switched on): the next steady page
    /// fires even if it is the one captured last.
    pub fn reset(&mut self) {
        *self = Self::default();
    }

    /// The camera starts again after a capture (the Adjust step stops it): keeps what was
    /// captured, so the same page is not taken again, but forgets the outline's motion. Until
    /// an outline is seen, missing frames (the camera warming up) do not re-arm it.
    pub fn resume(&mut self) {
        self.filled = 0;
        self.previous = None;
        self.steady_since = None;
        self.misses = 0;
        self.resuming = true;
    }

    /// The corner-wise median of the recent detections.
    fn smoothed(&self) -> Quad {
        let recent = &self.history[..self.filled];
        Quad(std::array::from_fn(|i| {
            let mut xs = [0.0f32; HISTORY];
            let mut ys = [0.0f32; HISTORY];
            for (k, q) in recent.iter().enumerate() {
                xs[k] = q.0[i].0;
                ys[k] = q.0[i].1;
            }
            (median(&xs[..recent.len()]), median(&ys[..recent.len()]))
        }))
    }

    /// One detection frame at `now_ms`: its outline (if any) and measurements.
    pub fn update(&mut self, quad: Option<&Quad>, stats: &FrameStats, now_ms: f64) -> Verdict {
        let dark = stats.luma < DARK_LUMA;
        let Some(quad) = quad else {
            if self.resuming {
                let hint = if dark {
                    Hint::MoreLight
                } else {
                    Hint::FindPage
                };
                return Verdict {
                    progress: 0.0,
                    fire: false,
                    hint,
                };
            }
            self.misses = self.misses.saturating_add(1);
            if self.misses > GRACE_MISSES {
                self.filled = 0;
                self.previous = None;
                self.steady_since = None;
            }
            if self
                .last_seen
                .is_none_or(|seen| now_ms - seen >= REARM_LOST_MS)
            {
                self.fired = None;
            }
            let hint = if dark {
                Hint::MoreLight
            } else {
                Hint::FindPage
            };
            return Verdict {
                progress: 0.0,
                fire: false,
                hint,
            };
        };
        self.misses = 0;
        self.resuming = false;
        self.last_seen = Some(now_ms);
        self.history[self.next] = *quad;
        self.next = (self.next + 1) % HISTORY;
        self.filled = (self.filled + 1).min(HISTORY);
        let outline = self.smoothed();
        let allowed = (diagonal(&outline) * MAX_DRIFT).max(MIN_DRIFT_PX);
        if let Some(fired) = self.fired
            && self.filled == HISTORY
            && drift(&fired, &outline) > diagonal(&outline) * REARM_DRIFT
        {
            self.fired = None;
        }
        let steady = self
            .previous
            .is_some_and(|prev| drift(&prev, &outline) < allowed);
        self.previous = Some(outline);
        let small = stats.area_share < MIN_AREA_SHARE;
        let sharp = stats.sharpness >= SHARPNESS_MIN;
        if !steady {
            self.steady_since = None;
        } else if self.steady_since.is_none() {
            self.steady_since = Some(now_ms);
        }
        let held = self.steady_since.map_or(0.0, |since| now_ms - since);
        let armed = self.fired.is_none();
        let fire = armed && sharp && held >= STEADY_MS;
        let progress = if fire {
            1.0
        } else if armed && sharp {
            (held / STEADY_MS).clamp(0.0, 1.0) as f32
        } else {
            0.0
        };
        if fire {
            self.fired = Some(outline);
            self.steady_since = None;
        }
        let hint = if small {
            Hint::MoveCloser
        } else if dark {
            Hint::MoreLight
        } else if armed && (!steady || !sharp) {
            Hint::HoldSteady
        } else {
            Hint::None
        };
        Verdict {
            progress,
            fire,
            hint,
        }
    }
}
