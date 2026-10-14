//! The WebAssembly ABI used by the scan worker (`packages/scan/src/wasm.ts`). No wasm-bindgen:
//! a handful of C-ABI functions over linear memory. Buffers cross as (pointer, length) pairs
//! allocated by `scan_alloc`; a buffer handed to a function that "takes" it must not be used
//! or freed by the caller afterwards.
#![allow(unsafe_code)]

use std::alloc::{Layout, alloc, dealloc};

use image::{GrayImage, RgbaImage};

use crate::{Filter, Quad, apply, detect, find_page, output_size, straighten};

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

/// Frees a buffer from `scan_alloc` (or returned by `scan_straighten`).
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

fn grey_of(pixels: &[u8], width: u32, height: u32) -> GrayImage {
    let mut gray = GrayImage::new(width, height);
    for (o, p) in gray.pixels_mut().zip(pixels.as_chunks::<4>().0) {
        o.0[0] = ((299 * u32::from(p[0]) + 587 * u32::from(p[1]) + 114 * u32::from(p[2]) + 500)
            / 1000) as u8;
    }
    gray
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

/// Looks for the page in a small RGBA frame (`width × height`, borrowed; about 320 px on the
/// long side). Writes the corners (x, y × 4: top-left, top-right, bottom-right, bottom-left)
/// to `out` and returns 1, or returns 0 when there is no page.
///
/// # Safety
/// `rgba` points to `width * height * 4` readable bytes, `out` to 8 writable `f32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_detect(
    rgba: *const u8,
    width: u32,
    height: u32,
    out: *mut f32,
) -> u32 {
    // SAFETY: per the contract above.
    let pixels = unsafe { std::slice::from_raw_parts(rgba, width as usize * height as usize * 4) };
    match detect(&grey_of(pixels, width, height)) {
        Some(quad) => {
            // SAFETY: the caller's contract covers `out`.
            unsafe { write_quad(&quad, out) };
            1
        }
        None => 0,
    }
}

/// Like `scan_detect` for a full-size photo (borrowed): found on a small copy, then sharpened
/// against the photo itself.
///
/// # Safety
/// As for `scan_detect`.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_find_page(
    rgba: *const u8,
    width: u32,
    height: u32,
    out: *mut f32,
) -> u32 {
    // SAFETY: per the contract above.
    let pixels = unsafe { std::slice::from_raw_parts(rgba, width as usize * height as usize * 4) };
    match find_page(&grey_of(pixels, width, height)) {
        Some(quad) => {
            // SAFETY: the caller's contract covers `out`.
            unsafe { write_quad(&quad, out) };
            1
        }
        None => 0,
    }
}

/// Applies `filter` (as for `scan_straighten`) to an RGBA image in place (borrowed). Returns 1,
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

/// Straightens the page `quad` (8 `f32`s, as `scan_detect` writes them) of a full-size RGBA
/// photo and applies `filter` (0 original, 1 grey, 2 black and white). Takes the photo buffer.
/// Returns the new RGBA image (free it with `scan_free(ptr, out_w * out_h * 4)`) and writes its
/// size to `out_size` (2 `u32`s), or returns 0 on failure (the photo is freed either way).
///
/// # Safety
/// `rgba` came from `scan_alloc(width * height * 4)`; `quad` points to 8 readable `f32`s and
/// `out_size` to 2 writable `u32`s.
#[unsafe(no_mangle)]
pub unsafe extern "C" fn scan_straighten(
    rgba: *mut u8,
    width: u32,
    height: u32,
    quad: *const f32,
    max_pixels: u32,
    filter: u32,
    out_size: *mut u32,
) -> *mut u8 {
    let len = width as usize * height as usize * 4;
    // SAFETY: per the contract above.
    let pixels = unsafe { take(rgba, len) };
    // SAFETY: per the contract above.
    let q = unsafe { std::slice::from_raw_parts(quad, 8) };
    let (Some(photo), Some(filter)) = (
        RgbaImage::from_raw(width, height, pixels),
        Filter::from_code(filter),
    ) else {
        return std::ptr::null_mut();
    };
    let quad = Quad(std::array::from_fn(|i| (q[i * 2], q[i * 2 + 1])));
    let (w, h) = output_size(&quad, u64::from(max_pixels));
    let Some(page) = straighten(&photo, &quad, w, h, filter) else {
        return std::ptr::null_mut();
    };
    drop(photo);
    // A boxed slice has exactly `len` bytes, the layout `scan_free(ptr, len)` expects.
    let bytes = page.into_raw().into_boxed_slice();
    let ptr = Box::into_raw(bytes).cast::<u8>();
    // SAFETY: per the contract above.
    let size = unsafe { std::slice::from_raw_parts_mut(out_size, 2) };
    size[0] = w;
    size[1] = h;
    ptr
}
