/**
 * Language and theme. Persisted in SQLite (via IPC); mirrored to localStorage
 * only to paint the right theme/language on the very first frame.
 */
import type { ThemeName } from "@selis/ui";
import { create } from "zustand";
import { api, type LocalePref, type Settings, type ThemePref } from "../lib/api";
import { setDarkSystemBars } from "../lib/platform";
import { type AppLocale, changeLocale, resolveLocale } from "../i18n";

const BOOT_KEY = "selis.boot-settings";

type SettingsState = Settings & {
  loaded: boolean;
  setLocale: (locale: LocalePref) => Promise<void>;
  setTheme: (theme: ThemePref) => Promise<void>;
};

const DEFAULTS: Settings = { locale: "system", theme: "system" };

function readBootSettings(): Settings {
  try {
    const raw = localStorage.getItem(BOOT_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      locale: parsed.locale === "el" || parsed.locale === "en" ? parsed.locale : "system",
      theme: parsed.theme === "light" || parsed.theme === "dark" || parsed.theme === "sepia" ? parsed.theme : "system",
    };
  } catch {
    return DEFAULTS;
  }
}

function writeBootSettings(settings: Settings): void {
  try {
    localStorage.setItem(BOOT_KEY, JSON.stringify({ locale: settings.locale, theme: settings.theme }));
  } catch {
    // Private mode / quota: the DB copy is authoritative anyway.
  }
}

const darkQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

export function resolveTheme(pref: ThemePref, systemDark: boolean): ThemeName {
  if (pref === "system") return systemDark ? "dark" : "light";
  return pref;
}

function applyTheme(pref: ThemePref): void {
  const theme = resolveTheme(pref, darkQuery?.matches ?? false);
  document.documentElement.dataset.theme = theme;
  setDarkSystemBars(theme === "dark");
}

function applyLocale(pref: LocalePref): AppLocale {
  const locale = resolveLocale(pref, navigator.languages);
  void changeLocale(locale);
  return locale;
}

export const useSettings = create<SettingsState>()((set, get) => {
  const persist = async (patch: Partial<Settings>) => {
    const previous: Settings = { locale: get().locale, theme: get().theme };
    const next = { ...previous, ...patch };
    // Optimistic: apply immediately, roll back if the backend refuses.
    set(next);
    writeBootSettings(next);
    try {
      const saved = await api.updateSettings({ locale: patch.locale ?? null, theme: patch.theme ?? null });
      set(saved);
      writeBootSettings(saved);
    } catch {
      set(previous);
      writeBootSettings(previous);
      applyTheme(previous.theme);
      applyLocale(previous.locale);
    }
  };

  return {
    ...readBootSettings(),
    loaded: false,
    setLocale: async (locale) => {
      applyLocale(locale);
      await persist({ locale });
    },
    setTheme: async (theme) => {
      applyTheme(theme);
      await persist({ theme });
    },
  };
});

/** Applies boot settings synchronously, then reconciles with the database. */
export function installSettings(): () => void {
  const boot = useSettings.getState();
  applyTheme(boot.theme);
  applyLocale(boot.locale);

  void (async () => {
    try {
      const stored = await api.getSettings();
      useSettings.setState({ ...stored, loaded: true });
      writeBootSettings(stored);
      applyTheme(stored.theme);
      applyLocale(stored.locale);
    } catch {
      useSettings.setState({ loaded: true });
    }
  })();

  const onSystemTheme = () => {
    if (useSettings.getState().theme === "system") applyTheme("system");
  };
  darkQuery?.addEventListener("change", onSystemTheme);
  return () => darkQuery?.removeEventListener("change", onSystemTheme);
}
