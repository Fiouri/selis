//! System file picker, driven from Rust so its outcome goes through the request
//! store (`take_result` can recover it if the reply is lost; see
//! docs/adr/0005-ipc-reliability.md).

use std::io::Read;
use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tauri_plugin_fs::{FsExt, OpenOptions};

use super::{CommandError, CommandResult, ErrorCode};
use crate::requests::RequestResults;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickOutcome {
    Picked { source: String },
    Cancelled,
}

pub(crate) fn to_source(path: FilePath) -> String {
    match path {
        FilePath::Url(url) => url.to_string(),
        FilePath::Path(path) => path.to_string_lossy().into_owned(),
    }
}

/// Opens the system picker for one PDF. Cancel (or a picker failure) yields
/// `Cancelled`. Runs once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_pdf<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickOutcome> {
    results
        .run_once(&request_id, "pick_pdf", async move {
            tauri::async_runtime::spawn_blocking(move || {
                match app
                    .dialog()
                    .file()
                    .add_filter("PDF", &["pdf"])
                    .blocking_pick_file()
                {
                    Some(path) => PickOutcome::Picked {
                        source: to_source(path),
                    },
                    None => PickOutcome::Cancelled,
                }
            })
            .await
            .map_err(|e| CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}")))
        })
        .await
}

/// Largest picture accepted for a signature (phone photos are 2–8 MB).
const MAX_IMAGE_BYTES: u64 = 12 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum PickedImage {
    Picked {
        mime: String,
        /// Base64 of the file (the Android IPC carries JSON only).
        data: String,
    },
    Cancelled,
}

/// PNG, JPEG or WebP by their magic bytes (what every WebView decodes).
fn image_mime(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if head.starts_with(b"\xff\xd8\xff") {
        Some("image/jpeg")
    } else if head.len() >= 12 && &head[..4] == b"RIFF" && &head[8..12] == b"WEBP" {
        Some("image/webp")
    } else {
        None
    }
}

/// Opens the system picker for one picture (a signature photographed on paper)
/// and returns its bytes. The file is opened read-only and never kept. Runs
/// once per `request_id`.
#[tauri::command]
#[specta::specta]
pub async fn pick_image<R: Runtime>(
    app: AppHandle<R>,
    results: State<'_, Arc<RequestResults>>,
    request_id: String,
) -> CommandResult<PickedImage> {
    results
        .run_once(&request_id, "pick_image", async move {
            tauri::async_runtime::spawn_blocking(move || {
                let Some(path) = app
                    .dialog()
                    .file()
                    .add_filter("Images", &["png", "jpg", "jpeg", "webp"])
                    .blocking_pick_file()
                else {
                    return Ok(PickedImage::Cancelled);
                };
                let mut opts = OpenOptions::new();
                opts.read(true);
                let file = app.fs().open(path, opts).map_err(|e| {
                    CommandError::new(ErrorCode::Io, format!("cannot open image: {e}"))
                })?;
                let mut bytes = Vec::new();
                file.take(MAX_IMAGE_BYTES + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|e| {
                        CommandError::new(ErrorCode::Io, format!("cannot read image: {e}"))
                    })?;
                if bytes.len() as u64 > MAX_IMAGE_BYTES {
                    return Err(CommandError::new(
                        ErrorCode::InvalidArgument,
                        "image too large",
                    ));
                }
                let mime = image_mime(&bytes).ok_or_else(|| {
                    CommandError::new(ErrorCode::Unsupported, "not a PNG, JPEG or WebP image")
                })?;
                Ok(PickedImage::Picked {
                    mime: mime.to_owned(),
                    data: STANDARD.encode(&bytes),
                })
            })
            .await
            .map_err(|e| {
                CommandError::new(ErrorCode::Internal, format!("picker task failed: {e}"))
            })?
        })
        .await
}

#[cfg(test)]
mod tests {
    use super::image_mime;

    #[test]
    fn recognises_png_jpeg_webp_only() {
        assert_eq!(image_mime(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(image_mime(b"\xff\xd8\xff\xe0"), Some("image/jpeg"));
        assert_eq!(image_mime(b"RIFF\0\0\0\0WEBPVP8 "), Some("image/webp"));
        assert_eq!(image_mime(b"GIF89a"), None);
        assert_eq!(image_mime(b"%PDF-1.7"), None);
    }
}
