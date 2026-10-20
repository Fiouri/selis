/**
 * Greek catalogue completeness (ADR 0030, amendment 2026-10-20). New strings go to en.json only;
 * el.json is filled in one translation-pass PR right before each release candidate. Until then a
 * key missing from el.json is a warning (the app shows the English text). In the translation pass
 * (`SELIS_TRANSLATION_PASS=1`: a PR labelled `translation-pass` or on a `translation-pass/*`
 * branch) and on a release tag it is a failure. A key in el.json that en.json no longer has is
 * always a failure: removing a string removes its translation too.
 *
 * Usage: node tools/i18n/check-el.ts [--strict]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type Messages = { [key: string]: string | Messages };

export function flatten(messages: Messages, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(messages)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out.set(path, value);
    else for (const [k, v] of flatten(value, path)) out.set(k, v);
  }
  return out;
}

export type ElReport = { readonly untranslated: string[]; readonly stale: string[] };

export function compareCatalogs(en: Messages, el: Messages): ElReport {
  const enKeys = flatten(en);
  const elKeys = flatten(el);
  return {
    untranslated: [...enKeys.keys()].filter((k) => !elKeys.has(k)).sort(),
    stale: [...elKeys.keys()].filter((k) => !enKeys.has(k)).sort(),
  };
}

/** True in the translation pass (PR label or branch, set by CI) and when asked explicitly. */
export function translationPass(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.SELIS_TRANSLATION_PASS === "1";
}

/** GitHub workflow-command lines for the report, and whether the check fails. */
export function verdict(report: ElReport, strict: boolean): { lines: string[]; failed: boolean } {
  const lines: string[] = [];
  if (report.stale.length > 0) {
    lines.push(`::error title=el.json::${report.stale.length} key(s) no longer in en.json: ${report.stale.join(", ")}`);
  }
  if (report.untranslated.length > 0) {
    const level = strict ? "error" : "warning";
    const when = strict ? "translate them in this translation pass" : "shown in English until the translation pass";
    lines.push(`::${level} title=el.json::${report.untranslated.length} key(s) not translated yet (${when}): ${report.untranslated.join(", ")}`);
  }
  return { lines, failed: report.stale.length > 0 || (strict && report.untranslated.length > 0) };
}

function main(): void {
  const dir = join(import.meta.dirname, "..", "..", "apps", "app", "src", "i18n");
  const read = (file: string) => JSON.parse(readFileSync(join(dir, file), "utf8")) as Messages;
  const strict = process.argv.includes("--strict") || translationPass();
  const { lines, failed } = verdict(compareCatalogs(read("en.json"), read("el.json")), strict);
  for (const line of lines) console.log(line);
  if (lines.length === 0) console.log("el.json: every en.json key is translated.");
  if (failed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
