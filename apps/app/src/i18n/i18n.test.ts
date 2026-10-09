import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { resolveLocale } from ".";
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

describe("i18n catalogs", () => {
  it("el and en define exactly the same keys", () => {
    expect([...catalogs.el.keys()].sort()).toEqual([...catalogs.en.keys()].sort());
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
      expect(vars(catalogs.el.get(key) ?? ""), key).toEqual(vars(message));
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
