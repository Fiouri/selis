/**
 * UI languages the e2e checks run in (ADR 0030, amendment 2026-10-20). English is required on
 * every change; Greek layout and visual sets run only in the translation pass before a release
 * candidate (`SELIS_TRANSLATION_PASS=1`, set by CI for a PR labelled `translation-pass`), when
 * el.json is complete. Between release candidates new keys exist in en.json only.
 */
export const TRANSLATION_PASS = process.env.SELIS_TRANSLATION_PASS === "1";

export const UI_LANGS: readonly ("en" | "el")[] = TRANSLATION_PASS ? ["en", "el"] : ["en"];
