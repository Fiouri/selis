/**
 * Dependency policy for what ships in the app (CLAUDE.md "Forbidden", ADR 0021): every npm
 * package that is not dev-only has a permissive licence, and no shipped dependency — npm, the
 * Android Gradle build or the Rust lockfile — is Google Play Services, Firebase, ML Kit, Play
 * Core, an analytics / crash-reporting / ads SDK or a forbidden PDF engine. F-Droid builds from
 * source and rejects proprietary libraries (https://f-droid.org/docs/Inclusion_Policy/);
 * Rust licences are cargo-deny's job (deny.toml).
 *
 * Usage: node tools/release/check-dependencies.ts
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

/** SPDX ids allowed in shipped npm packages (permissive; OFL for fonts). */
export const ALLOWED_LICENSES = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0", "Unlicense", "OFL-1.1", "Zlib", "BlueOak-1.0.0"]);

/** Names (npm packages, Maven groups, Rust crates) that must never ship. */
export const FORBIDDEN: ReadonlyArray<[RegExp, string]> = [
  [/^com\.google\.android\.gms(\.|:|$)/, "Google Play Services"],
  [/^com\.google\.firebase(\.|:|$)|^firebase(-|$)|^@firebase\//, "Firebase"],
  [/^com\.google\.mlkit(\.|:|$)|^com\.google\.android\.odml/, "ML Kit"],
  [/^com\.google\.android\.play(\.|:|$)/, "Play Core / Play libraries"],
  [/^com\.android\.billingclient/, "Play Billing"],
  [/^com\.google\.android\.ump|^com\.google\.ads|admob/i, "ads"],
  [/crashlytics|^@sentry\/|^sentry(-|$)|^io\.sentry|bugsnag|instabug|^@datadog\//i, "crash reporting"],
  [/analytics|posthog|mixpanel|amplitude|^@segment\/|appsflyer|adjust-sdk|^com\.facebook/i, "analytics / tracking"],
  [/^pdf-lib$|^@pdf-lib\/|mupdf/i, "forbidden PDF library (CLAUDE.md)"],
];

/** Whether an SPDX expression (`A`, `A OR B`, `(A OR B)`) allows a permissive choice. */
export function licenseAllowed(expression: string): boolean {
  const ids = expression.replace(/[()]/g, "").split(/\s+OR\s+/);
  return ids.some((id) => ALLOWED_LICENSES.has(id.trim()));
}

export function forbiddenReason(name: string): string | null {
  for (const [pattern, reason] of FORBIDDEN) if (pattern.test(name)) return reason;
  return null;
}

type LockPackage = { license?: string; dev?: boolean; devOptional?: boolean; link?: boolean };

/** Problems in the shipped (non-dev) npm packages of a package-lock.json v3. */
export function npmProblems(lock: { packages: Record<string, LockPackage> }): string[] {
  const out: string[] = [];
  for (const [path, pkg] of Object.entries(lock.packages)) {
    if (!path.includes("node_modules/") || pkg.dev === true || pkg.devOptional === true || pkg.link === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    const reason = forbiddenReason(name);
    if (reason) out.push(`npm ${name}: ${reason}`);
    if (!pkg.license) out.push(`npm ${name}: no licence in package-lock.json`);
    else if (!licenseAllowed(pkg.license)) out.push(`npm ${name}: licence ${pkg.license} is not on the allow list`);
  }
  return out;
}

/** Maven coordinates (`group:artifact`) declared in Gradle Kotlin scripts. */
export function gradleCoordinates(text: string): string[] {
  return [...text.matchAll(/(?:implementation|api|classpath|runtimeOnly)\(\s*"([^":]+:[^":]+)(?::[^"]*)?"\s*\)/g)].map((m) => m[1] ?? "");
}

/** Crate names in a Cargo.lock. */
export function cargoCrates(text: string): string[] {
  return [...text.matchAll(/^name = "([^"]+)"$/gm)].map((m) => m[1] ?? "");
}

function gradleFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "build" || entry === ".gradle" || entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...gradleFiles(path));
    else if (entry.endsWith(".gradle.kts") || entry.endsWith(".gradle")) out.push(path);
  }
  return out;
}

function main(): number {
  const problems = npmProblems(JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8")) as { packages: Record<string, LockPackage> });
  const android = join(ROOT, "apps", "app", "src-tauri", "gen", "android");
  for (const file of gradleFiles(android)) {
    for (const coordinate of gradleCoordinates(readFileSync(file, "utf8"))) {
      const reason = forbiddenReason(coordinate);
      if (reason) problems.push(`gradle ${coordinate} (${file.slice(ROOT.length + 1)}): ${reason}`);
    }
  }
  for (const crate of cargoCrates(readFileSync(join(ROOT, "Cargo.lock"), "utf8"))) {
    const reason = forbiddenReason(crate);
    if (reason) problems.push(`crate ${crate}: ${reason}`);
  }
  for (const p of problems) console.error(p);
  if (problems.length === 0) console.log("dependencies: shipped npm licences permissive; no GMS / Firebase / ML Kit / Play / analytics / ads in npm, Gradle or Cargo");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith("check-dependencies.ts")) process.exit(main());
