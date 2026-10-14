import { describe, expect, it } from "vitest";
import { cargoCrates, forbiddenReason, gradleCoordinates, licenseAllowed, npmProblems } from "./check-dependencies";

describe("dependency policy", () => {
  it("allows permissive licences and OR-choices with one", () => {
    expect(licenseAllowed("MIT")).toBe(true);
    expect(licenseAllowed("(MIT OR Apache-2.0)")).toBe(true);
    expect(licenseAllowed("GPL-3.0-only OR MIT")).toBe(true);
    expect(licenseAllowed("GPL-3.0-only")).toBe(false);
    expect(licenseAllowed("AGPL-3.0")).toBe(false);
    expect(licenseAllowed("SEE LICENSE IN LICENSE")).toBe(false);
  });

  it("names proprietary SDKs in every ecosystem and leaves open libraries alone", () => {
    expect(forbiddenReason("com.google.android.gms:play-services-base")).toBe("Google Play Services");
    expect(forbiddenReason("com.google.firebase:firebase-analytics")).toBe("Firebase");
    expect(forbiddenReason("@firebase/app")).toBe("Firebase");
    expect(forbiddenReason("com.google.mlkit:barcode-scanning")).toBe("ML Kit");
    expect(forbiddenReason("com.google.android.play:review")).toBe("Play Core / Play libraries");
    expect(forbiddenReason("@sentry/browser")).toBe("crash reporting");
    expect(forbiddenReason("pdf-lib")).toBe("forbidden PDF library (CLAUDE.md)");
    for (const ok of ["com.google.android.material:material", "androidx.webkit:webkit", "tesseract.js", "iroh", "jsqr"]) expect(forbiddenReason(ok), ok).toBeNull();
  });

  it("reads Gradle coordinates and Cargo.lock crates", () => {
    const gradle = 'dependencies {\n  implementation("androidx.webkit:webkit:1.14.0")\n  implementation("com.google.android.gms:play-services-base:18.5.0")\n  classpath("com.android.tools.build:gradle:8.11.0")\n}';
    expect(gradleCoordinates(gradle)).toEqual(["androidx.webkit:webkit", "com.google.android.gms:play-services-base", "com.android.tools.build:gradle"]);
    expect(cargoCrates('[[package]]\nname = "iroh"\nversion = "1"\n\n[[package]]\nname = "qpdf"\n')).toEqual(["iroh", "qpdf"]);
  });

  it("checks only the npm packages that ship", () => {
    const lock = {
      packages: {
        "": {},
        "node_modules/react": { license: "MIT" },
        "node_modules/a/node_modules/gpl-thing": { license: "GPL-3.0" },
        "node_modules/vitest": { license: "MIT", dev: true },
        "node_modules/gpl-dev-tool": { license: "GPL-3.0", dev: true },
        "node_modules/firebase": { license: "Apache-2.0" },
        "node_modules/no-licence": {},
      },
    };
    expect(npmProblems(lock)).toEqual(["npm gpl-thing: licence GPL-3.0 is not on the allow list", "npm firebase: Firebase", "npm no-licence: no licence in package-lock.json"]);
  });
});
