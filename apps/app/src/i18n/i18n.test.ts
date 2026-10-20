import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { i18n, initI18n, resolveLocale } from ".";
import el from "./el.json";
import en from "./en.json";

type Messages = { [key: string]: string | Messages };

function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

const catalogs = { el: flatten(el), en: flatten(en) };
/** English keys el.json does not have yet: shown in English until the translation pass. */
const untranslated = [...catalogs.en.keys()].filter((key) => !catalogs.el.has(key));
/** The translation pass before a release candidate (ADR 0030 amendment): el.json must be complete. */
const translationPass = import.meta.env.SELIS_TRANSLATION_PASS === "1";

describe("i18n catalogs", () => {
  it("el has no key that en lacks", () => {
    expect([...catalogs.el.keys()].filter((key) => !catalogs.en.has(key))).toEqual([]);
  });

  it.runIf(translationPass)("translation pass: el translates every en key", () => {
    expect(untranslated).toEqual([]);
  });

  for (const [locale, messages] of Object.entries(catalogs)) {
    it(`${locale}: every message is non-empty valid ICU`, () => {
      for (const [key, message] of messages) {
        expect(message.trim(), key).not.toBe("");
        expect(() => new IntlMessageFormat(message, locale), key).not.toThrow();
      }
    });
  }

  it("plurals render per locale", () => {
    const fmt = (locale: "el" | "en", count: number) =>
      new IntlMessageFormat(catalogs[locale].get("library.count") ?? "", locale).format({ count });
    expect(fmt("en", 0)).toBe("No documents");
    expect(fmt("en", 1)).toBe("1 document");
    expect(fmt("en", 1000)).toBe("1,000 documents");
    expect(fmt("el", 1)).toBe("1 έγγραφο");
    expect(fmt("el", 3)).toBe("3 έγγραφα");
  });

  it("placeholders match between languages", () => {
    // Argument names: "{name}" or "{name, plural, ...}" (not plural branch text like "{No documents}").
    const vars = (m: string) => [...m.matchAll(/\{(\w+)\s*[,}]/g)].map((x) => x[1]).sort();
    for (const [key, message] of catalogs.en) {
      const greek = catalogs.el.get(key);
      if (greek !== undefined) expect(vars(greek), key).toEqual(vars(message));
    }
  });
});

describe("missing translations", () => {
  it("a key absent from el.json shows the English text", async () => {
    await initI18n("el");
    expect(i18n.language).toBe("el");
    i18n.addResource("en", "translation", "fallbackProbe.onlyEnglish", "Only in English");
    expect(i18n.t("fallbackProbe.onlyEnglish")).toBe("Only in English");
    // A translated key still shows Greek.
    expect(i18n.t("library.count", { count: 1 })).toBe("1 έγγραφο");
    // Every English key Greek does not have yet resolves to its English message.
    for (const key of untranslated) {
      expect(i18n.t(key), key).toBe(i18n.t(key, { lng: "en" }));
    }
  });
});

describe("resolveLocale", () => {
  it("follows the OS for 'system'", () => {
    expect(resolveLocale("system", ["el-GR", "en-US"])).toBe("el");
    expect(resolveLocale("system", ["de-DE", "en-GB"])).toBe("en");
    expect(resolveLocale("system", ["fr-FR"])).toBe("en");
    expect(resolveLocale("el", ["en-US"])).toBe("el");
  });
});
