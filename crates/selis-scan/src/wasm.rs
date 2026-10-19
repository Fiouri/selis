//! The WebAssembly ABI used by the scan worker (`packages/scan/src/wasm.ts`). No wasm-bindgen:
//! a handful of C-ABI functions over linear memory. Buffers cross as (pointer, length) pairs
//! allocated by `scan_alloc`; a buffer handed to a function that "takes" it must not be used
//! or freed by the caller afterwards.
#![allow(unsafe_code)]

use std::alloc::{Layout, alloc, dealloc};
use std::cell::RefCell;

use image::{GrayImage, RgbaImage};

use crate::live::{AutoCapture, frame_stats};
use crate::{Edits, Filter, Quad, RelativeStroke, apply, detect_scored, find_page, render};

/// State of the live detection loop, kept between frames so the frame-sized buffers are not
/// allocated again for every frame: the grey copy of the frame (reallocated only when the frame
/// size changes) and the automatic-capture tracker.
struct Live {
    gray: GrayImage,
    auto: AutoCapture,
}

thread_local! {
    static LIVE: RefCell<Live> = RefCell::new(Live {
        gray: GrayImage::new(0, 0),
        auto: AutoCapture::new(),
    });
}

fn layout(len: usize) -> Option<Layout> {
    Layout::from_size_align(len.max(1), 1).ok()
}

/// Allocates `len` bytes; 0 when out of memory.
#[unsafe(no_mangle)]
pub extern "C" fn scan_alloc(len: usize) -> *mut u8 {
    match layout(len) {
        // SAFETY: the layout has a non-zero size.
        Some(l) => unsafe { alloc(l) },
        None => std::ptr::null_mut(),
    }
}

/// Frees a buffer from `scan_alloc` (or returned by `scan_render`).
///
/// # Safety
/// `ptr` came from `scan_alloc(len)` or a result of `len` bytes, and is not used afterwards.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_free(ptr: *mut u8, len: usize) {
    if let (false, Some(l)) = (ptr.is_null(), layout(len)) {
        // SAFETY: per the contract above.
        unsafe { dealloc(ptr, l) };
    }
}

/// Takes ownership of a `scan_alloc(len)` buffer as a vector.
///
/// # Safety
/// `ptr` came from `scan_alloc(len)` (alignment 1, capacity `len`) and is not used afterwards.
unsafe fn take(ptr: *mut u8, len: usize) -> Vec<u8> {
    // SAFETY: the global allocator gave out exactly this layout.
    unsafe { Vec::from_raw_parts(ptr, len, len.max(1)) }
}

/// Luma of RGBA `pixels` into `gray` (resized only when the size changed).
fn grey_into(gray: &mut GrayImage, pixels: &[u8], width: u32, height: u32) {
    if gray.dimensions() != (width, height) {
        *gray = GrayImage::new(width, height);
    }
    for (o, p) in gray.pixels_mut().zip(pixels.as_chunks::<4>().0) {
        o.0[0] = ((299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2]) + 500)
            / 1000) as u8;
    }
}

/// # Safety
/// `out` points to 8 writable `f32`s.
unsafe fn write_quad(quad: &Quad, out: *mut f32) {
    // SAFETY: per the contract above.
    let out = unsafe { std::slice::from_raw_parts_mut(out, 8) };
    for (i, (x, y)) in quad.0.iter().enumerate() {
        out[i * 2] = *x;
        out[i * 2 + 1] = *y;
    }
}

/// Number of `f32`s `scan_live` writes.
pub const LIVE_OUT: usize = 15;

/// One live frame (small RGBA, `width × height`, borrowed; about 320 px on the long side) taken
/// at `now_ms`: looks for the page and feeds the automatic-capture tracker. Writes `LIVE_OUT`
/// `f32`s to `out`: the corners (x, y × 4: top-left, top-right, bottom-right, bottom-left; only
/// when found), the sharpness, the mean luma, the outline's share of the frame, the steady
/// progress (0–1), 1 when the frame should be captured now (else 0), the hint code
/// (`live::Hint`) and the outline's edge support (0–1). Returns 1 when a page was found, 0
/// otherwise.
///
/// # Safety
/// `rgba` points to `width * height * 4` readable bytes, `out` to `LIVE_OUT` writable `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_live(
    rgba: *const u8,
    width: u32,
    height: u32,
    now_ms: f64,
    out: *mut f32,
) -> u32 {
    // SAFETY: per the contract above.
    let pixels = unsafe { std::slice::from_raw_parts(rgba, width as usize * height as usize * 4) };
    // SAFETY: per the contract above.
    let out = unsafe { std::slice::from_raw_parts_mut(out, LIVE_OUT) };
    LIVE.with_borrow_mut(|live| {
        grey_into(&mut live.gray, pixels, width, height);
        let found = detect_scored(&live.gray);
        let stats = frame_stats(&live.gray, found.as_ref().map(|(q, s)| (q, *s)));
        let quad = found.map(|(q, _)| q);
        let verdict = live.auto.update(quad.as_ref(), &stats, now_ms);
        if let Some(q) = &quad {
            for (i, (x, y)) in q.0.iter().enumerate() {
                out[i * 2] = *x;
                out[i * 2 + 1] = *y;
            }
        }
        out[8] = stats.sharpness;
        out[9] = stats.luma;
        out[10] = stats.area_share;
        out[11] = verdict.progress;
        out[12] = if verdict.fire { 1.0 } else { 0.0 };
        out[13] = f32::from(verdict.hint as u8);
        out[14] = stats.support;
        u32::from(quad.is_some())
    })
}

/// Resets the automatic-capture tracker (camera reopened, Retake, Auto switched on).
#[unsafe(no_mangle)]
pub extern "C" fn scan_auto_reset() {
    LIVE.with_borrow_mut(|live| live.auto.reset());
}

/// The camera starts again after a capture: the tracker keeps the captured page (no second
/// capture of it) and ignores the camera's first frames without an outline.
#[unsafe(no_mangle)]
pub extern "C" fn scan_auto_resume() {
    LIVE.with_borrow_mut(|live| live.auto.resume());
}

/// Looks for the page in a full-size RGBA photo (borrowed): found on a small copy, then
/// sharpened against the photo itself. Writes the corners as `scan_live` does (8 `f32`s) and
/// returns 1, or returns 0 when there is no page.
///
/// # Safety
/// `rgba` points to `width * height * 4` readable bytes, `out` to 8 writable `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_find_page(
    rgba: *const u8,
    width: u32,
    height: u32,
    out: *mut f32,
) -> u32 {
    // SAFETY: per the contract above.
    let pixels = unsafe { std::slice::from_raw_parts(rgba, width as usize * height as usize * 4) };
    let mut gray = GrayImage::new(0, 0);
    grey_into(&mut gray, pixels, width, height);
    match find_page(&gray) {
        Some(quad) => {
            // SAFETY: the caller's contract covers `out`.
            unsafe { write_quad(&quad, out) };
            1
        }
        None => 0,
    }
}

/// Applies `filter` (as for `scan_render`) to an RGBA image in place (borrowed). Returns 1,
/// or 0 for an unknown filter.
///
/// # Safety
/// `rgba` points to `width * height * 4` readable and writable bytes.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_filter(rgba: *mut u8, width: u32, height: u32, filter: u32) -> u32 {
    let len = width as usize * height as usize * 4;
    let Some(filter) = Filter::from_code(filter) else {
        return 0;
    };
    // SAFETY: per the contract above.
    let pixels = unsafe { std::slice::from_raw_parts_mut(rgba, len) };
    let Some(image) = RgbaImage::from_raw(width, height, pixels.to_vec()) else {
        return 0;
    };
    pixels.copy_from_slice(&apply(image, filter));
    1
}

/// Reads touch-up strokes from `f32`s: the stroke count, then per stroke its radius, its
/// point count and the points (x, y). `None` when the data is cut short.
fn strokes_of(data: &[f32]) -> Option<Vec<RelativeStroke>> {
    let mut it = data.iter().copied();
    let count = it.next().unwrap_or(0.0) as usize;
    let mut strokes = Vec::with_capacity(count.min(1024));
    for _ in 0..count {
        let radius = it.next()?;
        let n = it.next()? as usize;
        let mut points = Vec::with_capacity(n.min(4096));
        for _ in 0..n {
            points.push((it.next()?, it.next()?));
        }
        strokes.push(RelativeStroke { radius, points });
    }
    Some(strokes)
}

/// Makes a page from a full-size RGBA photo: straightens the page `quad` (8 `f32`s, as
/// `scan_live` writes them) to at most `max_pixels`, applies `filter` (0 original, 1 grey,
/// 2 black and white, 3 enhance), the touch-up strokes (`edits_len` `f32`s at `edits`, see
/// `strokes_of`; may be empty) and `quarter_turns` clockwise. Takes the photo buffer. Returns
/// the new RGBA image (free it with `scan_free(ptr, out_w * out_h * 4)`) and writes its size to
/// `out_size` (2 `u32`s), or returns 0 on failure (the photo is freed either way).
///
/// # Safety
/// `rgba` came from `scan_alloc(width * height * 4)`; `quad` points to 8 readable `f32`s,
/// `edits` to `edits_len` readable `f32`s (or is null with `edits_len` 0) and `out_size` to 2
/// writable `u32`s.
#[unsafe(no_mangle)]
#[allow(clippy::too_many_arguments)]
pub unsafe extern "C" fn scan_render(
    rgba: *mut u8,
    width: u32,
    height: u32,
    quad: *const f32,
    max_pixels: u32,
    filter: u32,
    edits: *const f32,
    edits_len: u32,
    quarter_turns: u32,
    out_size: *mut u32,
) -> *mut u8 {
    let len = width as usize * height as usize * 4;
    // SAFETY: per the contract above.
    let pixels = unsafe { take(rgba, len) };
    // SAFETY: per the contract above.
    let q = unsafe { std::slice::from_raw_parts(quad, 8) };
    let data: &[f32] = if edits.is_null() || edits_len == 0 {
        &[]
    } else {
        // SAFETY: per the contract above.
        unsafe { std::slice::from_raw_parts(edits, edits_len as usize) }
    };
    let (Some(photo), Some(filter), Some(strokes)) = (
        RgbaImage::from_raw(width, height, pixels),
        Filter::from_code(filter),
        strokes_of(data),
    ) else {
        return std::ptr::null_mut();
    };
    let quad = Quad(std::array::from_fn(|i| (q[i * 2], q[i * 2 + 1])));
    let edits = Edits {
        filter,
        strokes,
        quarter_turns,
    };
    let Some(page) = render(&photo, &quad, u64::from(max_pixels), &edits) else {
        return std::ptr::null_mut();
    };
    drop(photo);
    let (w, h) = page.dimensions();
    // A boxed slice has exactly `len` bytes, the layout `scan_free(ptr, len)` expects.
    let bytes = page.into_raw().into_boxed_slice();
    let ptr = Box::into_raw(bytes).cast::<u8>();
    // SAFETY: per the contract above.
    let size = unsafe { std::slice::from_raw_parts_mut(out_size, 2) };
    size[0] = w;
    size[1] = h;
    ptr
}
