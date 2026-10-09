import i18next from "i18next";
import ICU from "i18next-icu";
import { initReactI18next } from "react-i18next";
import el from "./el.json";
import en from "./en.json";

export const LOCALES = ["el", "en"] as const;
export type AppLocale = (typeof LOCALES)[number];

export const resources = { el: { translation: el }, en: { translation: en } } as const;

/** "system" follows the OS: Greek if any preferred language is Greek, else English. */
export function resolveLocale(pref: "system" | AppLocale, preferred: readonly string[]): AppLocale {
  if (pref !== "system") return pref;
  for (const tag of preferred) {
    const base = tag.toLowerCase().split("-")[0];
    if (base === "el") return "el";
    if (base === "en") return "en";
  }
  return "en";
}

export const i18n = i18next.createInstance();

export async function initI18n(locale: AppLocale): Promise<void> {
  if (i18n.isInitialized) {
    await changeLocale(locale);
    return;
  }
  await i18n
    .use(new ICU())
    .use(initReactI18next)
    .init({
      resources,
      lng: locale,
      fallbackLng: "en",
      supportedLngs: LOCALES,
      interpolation: { escapeValue: false },
      returnNull: false,
      react: { useSuspense: false },
    });
  document.documentElement.lang = locale;
}

export async function changeLocale(locale: AppLocale): Promise<void> {
  if (!i18n.isInitialized || i18n.language === locale) return;
  await i18n.changeLanguage(locale);
  document.documentElement.lang = locale;
}
