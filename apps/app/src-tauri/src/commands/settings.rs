use std::sync::Arc;

use selis_core::{Library, LibrarySort, RetentionPolicy};
use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::State;

use super::{CommandError, CommandResult, ErrorCode};

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

/// Allowed values (the pickers offer a subset).
/// At least 2: v1 (the original) and the current version are always kept.
pub const VERSIONS_PER_DOCUMENT: std::ops::RangeInclusive<u32> = 2..=100;
pub const HISTORY_LIMIT_MB: std::ops::RangeInclusive<u32> = 10..=10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub locale: LocalePref,
    pub theme: ThemePref,
    pub library_sort: LibrarySort,
    pub library_view: LibraryView,
    /// Reader night mode for pages (lightness inverted, images kept).
    pub night_mode: bool,
    /// Transfer without the relay, same Wi-Fi only (used from P3).
    pub local_only: bool,
    /// Versions kept per document, the current one included.
    pub versions_per_document: u32,
    /// History kept per document (versions other than v1 and the current one), in MB.
    pub history_limit_mb: u32,
    /// App lock (biometric gate lands later; the choice is stored now).
    pub app_lock: bool,
}

impl Default for Settings {
    fn default() -> Self {
        let retention = RetentionPolicy::default();
        Self {
            locale: LocalePref::default(),
            theme: ThemePref::default(),
            library_sort: LibrarySort::default(),
            library_view: LibraryView::default(),
            night_mode: false,
            local_only: false,
            versions_per_document: retention.versions_per_document,
            history_limit_mb: u32::try_from(retention.history_limit_bytes / (1024 * 1024))
                .unwrap_or(200),
            app_lock: false,
        }
    }
}

impl Settings {
    pub fn retention(&self) -> RetentionPolicy {
        RetentionPolicy {
            versions_per_document: self.versions_per_document,
            history_limit_bytes: u64::from(self.history_limit_mb) * 1024 * 1024,
        }
    }
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
    pub local_only: Option<bool>,
    pub versions_per_document: Option<u32>,
    pub history_limit_mb: Option<u32>,
    pub app_lock: Option<bool>,
}

const KEY_LOCALE: &str = "locale";
const KEY_THEME: &str = "theme";
const KEY_LIBRARY_SORT: &str = "librarySort";
const KEY_LIBRARY_VIEW: &str = "libraryView";
const KEY_NIGHT_MODE: &str = "nightMode";
const KEY_LOCAL_ONLY: &str = "localOnly";
const KEY_VERSIONS_PER_DOCUMENT: &str = "versionsPerDocument";
const KEY_HISTORY_LIMIT_MB: &str = "historyLimitMb";
const KEY_APP_LOCK: &str = "appLock";

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
            KEY_LOCAL_ONLY => settings.local_only = value.as_bool().unwrap_or_default(),
            KEY_APP_LOCK => settings.app_lock = value.as_bool().unwrap_or_default(),
            KEY_VERSIONS_PER_DOCUMENT => {
                if let Some(v) = in_range(&value, &VERSIONS_PER_DOCUMENT) {
                    settings.versions_per_document = v;
                }
            }
            KEY_HISTORY_LIMIT_MB => {
                if let Some(v) = in_range(&value, &HISTORY_LIMIT_MB) {
                    settings.history_limit_mb = v;
                }
            }
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
    apply_patch(&library, patch)
}

/// Validates and stores a partial update; tightened retention limits apply at once.
fn apply_patch(library: &Library, patch: SettingsPatch) -> CommandResult<Settings> {
    if let Some(v) = patch.versions_per_document {
        check_range("versionsPerDocument", v, &VERSIONS_PER_DOCUMENT)?;
    }
    if let Some(v) = patch.history_limit_mb {
        check_range("historyLimitMb", v, &HISTORY_LIMIT_MB)?;
    }
    store(library, KEY_LOCALE, patch.locale)?;
    store(library, KEY_THEME, patch.theme)?;
    store(library, KEY_LIBRARY_SORT, patch.library_sort)?;
    store(library, KEY_LIBRARY_VIEW, patch.library_view)?;
    store(library, KEY_NIGHT_MODE, patch.night_mode)?;
    store(library, KEY_LOCAL_ONLY, patch.local_only)?;
    store(library, KEY_APP_LOCK, patch.app_lock)?;
    let retention_changed =
        patch.versions_per_document.is_some() || patch.history_limit_mb.is_some();
    store(
        library,
        KEY_VERSIONS_PER_DOCUMENT,
        patch.versions_per_document,
    )?;
    store(library, KEY_HISTORY_LIMIT_MB, patch.history_limit_mb)?;
    let settings = load(library)?;
    if retention_changed {
        // Tightened limits take effect at once (P2 saves apply them too).
        library.apply_retention(&settings.retention())?;
    }
    Ok(settings)
}

fn in_range(value: &serde_json::Value, range: &std::ops::RangeInclusive<u32>) -> Option<u32> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| range.contains(v))
}

fn check_range(name: &str, value: u32, range: &std::ops::RangeInclusive<u32>) -> CommandResult<()> {
    if range.contains(&value) {
        Ok(())
    } else {
        Err(CommandError::new(
            ErrorCode::InvalidArgument,
            format!("{name} must be in {}..={}", range.start(), range.end()),
        ))
    }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn library() -> (tempfile::TempDir, Library) {
        let dir = tempfile::tempdir().expect("tempdir");
        let lib = Library::open(dir.path()).expect("library");
        (dir, lib)
    }

    #[test]
    fn defaults_match_the_brief() {
        let (_dir, lib) = library();
        let s = load(&lib).expect("load");
        assert_eq!((s.versions_per_document, s.history_limit_mb), (10, 200));
        assert!(!s.local_only && !s.app_lock && !s.night_mode);
        assert_eq!(s.theme, ThemePref::System);
    }

    #[test]
    fn stores_and_validates_a_patch() {
        let (_dir, lib) = library();
        let saved = apply_patch(
            &lib,
            SettingsPatch {
                local_only: Some(true),
                versions_per_document: Some(20),
                history_limit_mb: Some(500),
                theme: Some(ThemePref::Sepia),
                ..SettingsPatch::default()
            },
        )
        .expect("patch");
        assert!(saved.local_only);
        assert_eq!(
            (saved.versions_per_document, saved.history_limit_mb),
            (20, 500)
        );
        assert_eq!(load(&lib).expect("reload").theme, ThemePref::Sepia);

        let refused = apply_patch(
            &lib,
            SettingsPatch {
                versions_per_document: Some(0),
                local_only: Some(false),
                ..SettingsPatch::default()
            },
        );
        assert!(refused.is_err());
        // Nothing of a refused patch is stored.
        assert!(load(&lib).expect("reload").local_only);
    }
}
