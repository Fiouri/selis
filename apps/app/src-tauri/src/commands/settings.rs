use std::sync::Arc;

use selis_core::{Library, LibrarySort};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::CommandResult;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LocalePref {
    #[default]
    System,
    El,
    En,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ThemePref {
    #[default]
    System,
    Light,
    Dark,
    Sepia,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum LibraryView {
    #[default]
    Grid,
    List,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub locale: LocalePref,
    pub theme: ThemePref,
    pub library_sort: LibrarySort,
    pub library_view: LibraryView,
    /// Reader night mode for pages (lightness inverted, images kept).
    pub night_mode: bool,
}

/// Partial update; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub locale: Option<LocalePref>,
    pub theme: Option<ThemePref>,
    pub library_sort: Option<LibrarySort>,
    pub library_view: Option<LibraryView>,
    pub night_mode: Option<bool>,
}

const KEY_LOCALE: &str = "locale";
const KEY_THEME: &str = "theme";
const KEY_LIBRARY_SORT: &str = "librarySort";
const KEY_LIBRARY_VIEW: &str = "libraryView";
const KEY_NIGHT_MODE: &str = "nightMode";

fn load(library: &Library) -> CommandResult<Settings> {
    let mut settings = Settings::default();
    for (key, value) in library.settings()? {
        // Unknown or malformed values fall back to defaults instead of failing startup.
        match key.as_str() {
            KEY_LOCALE => settings.locale = serde_json::from_value(value).unwrap_or_default(),
            KEY_THEME => settings.theme = serde_json::from_value(value).unwrap_or_default(),
            KEY_LIBRARY_SORT => {
                settings.library_sort = serde_json::from_value(value).unwrap_or_default();
            }
            KEY_LIBRARY_VIEW => {
                settings.library_view = serde_json::from_value(value).unwrap_or_default();
            }
            KEY_NIGHT_MODE => settings.night_mode = value.as_bool().unwrap_or_default(),
            _ => {}
        }
    }
    Ok(settings)
}

#[tauri::command]
#[specta::specta]
pub async fn get_settings(library: State<'_, Arc<Library>>) -> CommandResult<Settings> {
    load(&library)
}

#[tauri::command]
#[specta::specta]
pub async fn update_settings(
    library: State<'_, Arc<Library>>,
    patch: SettingsPatch,
) -> CommandResult<Settings> {
    store(&library, KEY_LOCALE, patch.locale)?;
    store(&library, KEY_THEME, patch.theme)?;
    store(&library, KEY_LIBRARY_SORT, patch.library_sort)?;
    store(&library, KEY_LIBRARY_VIEW, patch.library_view)?;
    store(&library, KEY_NIGHT_MODE, patch.night_mode)?;
    load(&library)
}

fn store<T: Serialize>(library: &Library, key: &str, value: Option<T>) -> CommandResult<()> {
    if let Some(value) = value {
        library.set_setting(
            key,
            &serde_json::to_value(value).map_err(selis_core::Error::from)?,
        )?;
    }
    Ok(())
}
