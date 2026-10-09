use std::sync::Arc;

use selis_core::Library;
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

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub locale: LocalePref,
    pub theme: ThemePref,
}

/// Partial update; `None` fields are left unchanged.
#[derive(Debug, Clone, Default, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub locale: Option<LocalePref>,
    pub theme: Option<ThemePref>,
}

const KEY_LOCALE: &str = "locale";
const KEY_THEME: &str = "theme";

fn load(library: &Library) -> CommandResult<Settings> {
    let mut settings = Settings::default();
    for (key, value) in library.settings()? {
        // Unknown or malformed values fall back to defaults instead of failing startup.
        match key.as_str() {
            KEY_LOCALE => settings.locale = serde_json::from_value(value).unwrap_or_default(),
            KEY_THEME => settings.theme = serde_json::from_value(value).unwrap_or_default(),
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
    if let Some(locale) = patch.locale {
        library.set_setting(KEY_LOCALE, &serde_json::to_value(locale).map_err(selis_core::Error::from)?)?;
    }
    if let Some(theme) = patch.theme {
        library.set_setting(KEY_THEME, &serde_json::to_value(theme).map_err(selis_core::Error::from)?)?;
    }
    load(&library)
}
