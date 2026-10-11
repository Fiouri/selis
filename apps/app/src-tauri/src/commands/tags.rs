use std::sync::Arc;

use selis_core::{Document, Library, Tag};
use tauri::State;

use super::CommandResult;

#[tauri::command]
#[specta::specta]
pub async fn list_tags(library: State<'_, Arc<Library>>) -> CommandResult<Vec<Tag>> {
    Ok(library.list_tags()?)
}

/// Returns the existing tag when one with the same (folded) name exists.
#[tauri::command]
#[specta::specta]
pub async fn create_tag(library: State<'_, Arc<Library>>, name: String) -> CommandResult<Tag> {
    Ok(library.create_tag(&name)?)
}

#[tauri::command]
#[specta::specta]
pub async fn rename_tag(
    library: State<'_, Arc<Library>>,
    id: String,
    name: String,
) -> CommandResult<Tag> {
    Ok(library.rename_tag(&id, &name)?)
}

#[tauri::command]
#[specta::specta]
pub async fn delete_tag(library: State<'_, Arc<Library>>, id: String) -> CommandResult<()> {
    Ok(library.delete_tag(&id)?)
}

/// Replaces the document's tag set (idempotent).
#[tauri::command]
#[specta::specta]
pub async fn set_document_tags(
    library: State<'_, Arc<Library>>,
    document_id: String,
    tag_ids: Vec<String>,
) -> CommandResult<Document> {
    Ok(library.set_document_tags(&document_id, &tag_ids)?)
}
