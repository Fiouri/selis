//! Saved visual signatures (images; not PAdES). Logic in `selis_core::signatures`.

use std::sync::Arc;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use selis_core::{Library, Signature, SignatureKind, signatures::MAX_SIGNATURE_BYTES};
use tauri::State;

use super::{CommandError, CommandResult, ErrorCode};

/// Newest first.
#[tauri::command]
#[specta::specta]
pub async fn list_signatures(library: State<'_, Arc<Library>>) -> CommandResult<Vec<Signature>> {
    Ok(library.list_signatures()?)
}

/// Stores a transparent PNG (base64) under the UI-chosen `id`. Safe to repeat.
#[tauri::command]
#[specta::specta]
pub async fn save_signature(
    library: State<'_, Arc<Library>>,
    id: String,
    kind: SignatureKind,
    png: String,
) -> CommandResult<Signature> {
    if png.len() > MAX_SIGNATURE_BYTES.div_ceil(3) * 4 {
        return Err(CommandError::new(
            ErrorCode::InvalidArgument,
            "signature image too large",
        ));
    }
    let bytes = STANDARD
        .decode(png.as_bytes())
        .map_err(|e| CommandError::new(ErrorCode::InvalidArgument, format!("bad base64: {e}")))?;
    Ok(library.save_signature(&id, kind, &bytes)?)
}

/// Forgets a saved signature; placed copies in documents stay. Idempotent.
#[tauri::command]
#[specta::specta]
pub async fn delete_signature(library: State<'_, Arc<Library>>, id: String) -> CommandResult<()> {
    Ok(library.delete_signature(&id)?)
}
