/**
 * The app version and every number derived from it (ADR 0020).
 *
 * Single source of truth: `version` in the root package.json (SemVer, `X.Y.Z` or `X.Y.Z-rc.N`).
 * `node tools/release/version.ts set <version>` writes it there and derives the rest; `check`
 * (CI) fails when anything is out of step:
 *
 * - apps/app/package.json, package-lock.json (root and apps/app) and the Cargo workspace
 *   version: the same string.
 * - tauri.conf.json `version`: the same string (desktop, Android versionName).
 * - Android versionCode (`bundle.android.versionCode`): `build × 10`, where
 *   build = ((major × 100 + minor) × 100 + patch) × 100 + stage, stage = N for `-rc.N`
 *   (1–98) and 99 for the release. The last digit is the ABI: 0 for the AAB and the
 *   universal APK, 1–4 for the per-ABI APKs (gradle, `ABI_DIGITS`). An rc sorts before its
 *   release and every release after every rc: Play only accepts a higher code.
 * - iOS: CFBundleShortVersionString = `X.Y.Z` (App Store Connect rejects a pre-release
 *   suffix), CFBundleVersion = `build` (`bundle.iOS.bundleVersion`), also increasing.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type Version = { major: number; minor: number; patch: number; rc: number | null };

/** Per-ABI APK digits; the same table is in gen/android/app/build.gradle.kts. */
export const ABI_DIGITS = { universal: 0, arm64: 1, arm: 2, x86_64: 3, x86: 4 } as const;
export type Abi = keyof typeof ABI_DIGITS;

const PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-rc\.([1-9]\d*))?$/;

export function parseVersion(text: string): Version {
  const m = text.match(PATTERN);
  if (!m) throw new Error(`"${text}" is not X.Y.Z or X.Y.Z-rc.N`);
  const version = { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: m[4] === undefined ? null : Number(m[4]) };
  if (version.minor > 99 || version.patch > 99) throw new Error(`"${text}": minor and patch must be ≤ 99`);
  if (version.rc !== null && version.rc > 98) throw new Error(`"${text}": rc must be ≤ 98`);
  // The largest versionCode (build × 10 + 4) must stay below Play's 2 100 000 000.
  if (version.major > 209) throw new Error(`"${text}": major must be ≤ 209`);
  return version;
}

/** The increasing build number shared by Android and iOS. */
export function buildNumber(v: Version): number {
  return ((v.major * 100 + v.minor) * 100 + v.patch) * 100 + (v.rc ?? 99);
}

export function androidVersionCode(v: Version, abi: Abi = "universal"): number {
  return buildNumber(v) * 10 + ABI_DIGITS[abi];
}

export function iosVersions(v: Version): { shortVersion: string; bundleVersion: string } {
  return { shortVersion: `${String(v.major)}.${String(v.minor)}.${String(v.patch)}`, bundleVersion: String(buildNumber(v)) };
}

type Json = Record<string, unknown>;
export type VersionFiles = { root: Json; app: Json; lock: Json; cargo: string; tauri: Json; changelog: string };

const CARGO_VERSION = /(\[workspace\.package\][^[]*?\nversion = ")([^"]+)(")/;

function cargoVersion(text: string): string | null {
  return text.match(CARGO_VERSION)?.[2] ?? null;
}

function lockVersions(lock: Json): unknown[] {
  const packages = (lock.packages ?? {}) as Record<string, Json | undefined>;
  return [lock.version, packages[""]?.version, packages["apps/app"]?.version];
}

function platform(conf: Json, key: "android" | "iOS"): Json {
  const b = conf.bundle;
  if (typeof b !== "object" || b === null) throw new Error("tauri.conf.json has no bundle");
  const holder = b as Json;
  const value = holder[key];
  if (typeof value === "object" && value !== null) return value as Json;
  const created: Json = {};
  holder[key] = created;
  return created;
}

/** Every derived value that differs from what the root version implies (empty: all in step). */
export function problems(files: VersionFiles, tag?: string): string[] {
  const version = files.root.version;
  if (typeof version !== "string") return ["package.json has no version"];
  const v = parseVersion(version);
  const ios = iosVersions(v);
  const out: string[] = [];
  if (files.app.version !== version) out.push(`apps/app/package.json version is ${String(files.app.version)}`);
  if (lockVersions(files.lock).some((v) => v !== version)) out.push(`package-lock.json versions are ${lockVersions(files.lock).map(String).join(", ")}`);
  if (cargoVersion(files.cargo) !== version) out.push(`Cargo.toml [workspace.package] version is ${String(cargoVersion(files.cargo))}`);
  if (files.tauri.version !== version) out.push(`tauri.conf.json version is ${String(files.tauri.version)}`);
  const code = platform(files.tauri, "android").versionCode;
  if (code !== androidVersionCode(v)) out.push(`tauri.conf.json bundle.android.versionCode is ${String(code)}, expected ${String(androidVersionCode(v))}`);
  const bundleVersion = platform(files.tauri, "iOS").bundleVersion;
  if (bundleVersion !== ios.bundleVersion) out.push(`tauri.conf.json bundle.iOS.bundleVersion is ${String(bundleVersion)}, expected ${ios.bundleVersion}`);
  if (!files.changelog.includes(`## [${version}]`)) out.push(`CHANGELOG.md has no "## [${version}]" section`);
  if (tag !== undefined && tag !== `v${version}`) out.push(`tag ${tag} does not match version ${version}`);
  return out;
}

/** Writes `version` and everything derived from it into `files` (in place). */
export function applyVersion(files: VersionFiles, version: string): void {
  const v = parseVersion(version);
  if (!CARGO_VERSION.test(files.cargo)) throw new Error("Cargo.toml has no [workspace.package] version");
  files.root.version = version;
  files.app.version = version;
  files.lock.version = version;
  const packages = (files.lock.packages ?? {}) as Record<string, Json | undefined>;
  for (const key of ["", "apps/app"]) {
    const entry = packages[key];
    if (entry) entry.version = version;
  }
  files.tauri.version = version;
  platform(files.tauri, "android").versionCode = androidVersionCode(v);
  platform(files.tauri, "iOS").bundleVersion = iosVersions(v).bundleVersion;
  files.cargo = files.cargo.replace(CARGO_VERSION, `$1${version}$3`);
}

const ROOT = join(import.meta.dirname, "..", "..");
const PATHS = {
  root: join(ROOT, "package.json"),
  app: join(ROOT, "apps", "app", "package.json"),
  lock: join(ROOT, "package-lock.json"),
  cargo: join(ROOT, "Cargo.toml"),
  tauri: join(ROOT, "apps", "app", "src-tauri", "tauri.conf.json"),
  changelog: join(ROOT, "CHANGELOG.md"),
};

const readJson = (path: string): Json => JSON.parse(readFileSync(path, "utf8")) as Json;
const writeJson = (path: string, value: Json): void => {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

function load(): VersionFiles {
  return {
    root: readJson(PATHS.root),
    app: readJson(PATHS.app),
    lock: readJson(PATHS.lock),
    cargo: readFileSync(PATHS.cargo, "utf8"),
    tauri: readJson(PATHS.tauri),
    changelog: readFileSync(PATHS.changelog, "utf8"),
  };
}

function main(argv: string[]): number {
  const [command, arg] = argv;
  const files = load();
  if (command === "set" && arg) {
    applyVersion(files, arg);
    writeJson(PATHS.root, files.root);
    writeJson(PATHS.app, files.app);
    writeJson(PATHS.lock, files.lock);
    writeJson(PATHS.tauri, files.tauri);
    writeFileSync(PATHS.cargo, files.cargo);
    console.log(`version ${arg}: run \`cargo check\` (Cargo.lock) and add a CHANGELOG.md section`);
    return 0;
  }
  if (command === "check") {
    const found = problems(files, arg);
    for (const p of found) console.error(`version: ${p}`);
    if (found.length === 0) console.log(`version ${String(files.root.version)}: all derived values in step`);
    return found.length === 0 ? 0 : 1;
  }
  const version = parseVersion(String(files.root.version));
  if (command === "show") {
    const android = Object.fromEntries(Object.keys(ABI_DIGITS).map((abi) => [abi, androidVersionCode(version, abi as Abi)]));
    console.log(JSON.stringify({ version: files.root.version, prerelease: version.rc !== null, build: buildNumber(version), android, ios: iosVersions(version) }, null, 2));
    return 0;
  }
  if (command === "ios-config") {
    // `tauri ios build --config <this>`: App Store Connect wants X.Y.Z as the short version.
    const ios = iosVersions(version);
    console.log(JSON.stringify({ version: ios.shortVersion, bundle: { iOS: { bundleVersion: ios.bundleVersion } } }));
    return 0;
  }
  console.error("usage: node tools/release/version.ts set <X.Y.Z[-rc.N]> | check [tag] | show | ios-config");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) process.exit(main(process.argv.slice(2)));
