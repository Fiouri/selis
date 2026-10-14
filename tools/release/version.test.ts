import { describe, expect, it } from "vitest";
import { androidVersionCode, applyVersion, buildNumber, iosVersions, parseVersion, problems, type VersionFiles } from "./version";

const files = (): VersionFiles => ({
  root: { name: "selis", version: "0.1.0" },
  app: { name: "@selis/app", version: "0.1.0" },
  lock: { version: "0.1.0", packages: { "": { version: "0.1.0" }, "apps/app": { version: "0.1.0" }, "packages/ui": { version: "0.1.0" } } },
  cargo: '[workspace]\nmembers = []\n\n[workspace.package]\nversion = "0.1.0"\nedition = "2024"\n',
  tauri: { version: "0.1.0", bundle: { active: true } },
  changelog: "# Changelog\n\n## [1.0.0-rc.1] - 2026-10-14\n",
});

describe("version scheme", () => {
  it("orders rcs before their release and releases before the next rcs", () => {
    const codes = ["1.0.0-rc.1", "1.0.0-rc.2", "1.0.0", "1.0.1-rc.1", "1.0.1", "1.1.0", "2.0.0-rc.1"].map((t) => androidVersionCode(parseVersion(t)));
    expect([...codes].sort((a, b) => a - b)).toEqual(codes);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("derives Android and iOS numbers", () => {
    const rc = parseVersion("1.0.0-rc.1");
    expect(buildNumber(rc)).toBe(1_000_001);
    expect(androidVersionCode(rc)).toBe(10_000_010);
    expect(androidVersionCode(rc, "arm64")).toBe(10_000_011);
    expect(androidVersionCode(parseVersion("1.0.0"), "x86")).toBe(10_000_994);
    expect(iosVersions(rc)).toEqual({ shortVersion: "1.0.0", bundleVersion: "1000001" });
    // Play's ceiling.
    expect(androidVersionCode(parseVersion("209.99.99"), "x86")).toBeLessThan(2_100_000_000);
  });

  it("rejects what the scheme cannot order", () => {
    for (const bad of ["1.0", "1.0.0-beta.1", "1.0.0-rc.0", "1.0.0-rc.99", "1.100.0", "01.0.0", "210.0.0", "v1.0.0"]) {
      expect(() => parseVersion(bad), bad).toThrow();
    }
  });
});

describe("derived files", () => {
  it("writes every derived value and then finds nothing out of step", () => {
    const f = files();
    expect(problems(f).length).toBeGreaterThan(0);
    applyVersion(f, "1.0.0-rc.1");
    expect(f.lock).toMatchObject({ version: "1.0.0-rc.1", packages: { "": { version: "1.0.0-rc.1" }, "apps/app": { version: "1.0.0-rc.1" }, "packages/ui": { version: "0.1.0" } } });
    expect(f.cargo).toContain('version = "1.0.0-rc.1"\nedition');
    expect(f.tauri).toMatchObject({ version: "1.0.0-rc.1", bundle: { android: { versionCode: 10_000_010 }, iOS: { bundleVersion: "1000001" } } });
    expect(problems(f)).toEqual([]);
    expect(problems(f, "v1.0.0-rc.1")).toEqual([]);
  });

  it("names each value out of step, the changelog and a wrong tag", () => {
    const f = files();
    applyVersion(f, "1.0.0-rc.1");
    f.app.version = "1.0.0";
    f.changelog = "# Changelog\n";
    expect(problems(f, "v1.0.0")).toEqual([
      "apps/app/package.json version is 1.0.0",
      'CHANGELOG.md has no "## [1.0.0-rc.1]" section',
      "tag v1.0.0 does not match version 1.0.0-rc.1",
    ]);
  });
});
