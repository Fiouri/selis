# iOS export compliance (encryption) — decision for the owner

Status 2026-10-14: **open**. `ITSAppUsesNonExemptEncryption` is deliberately **not set** in
`Info.plist` until you decide (without the key, App Store Connect asks the questions at each
upload; TestFlight builds wait on the answer). Not legal advice.

## What Selis encrypts

| Where | Algorithm | Implementation | Purpose |
| --- | --- | --- | --- |
| Transfer (ADR 0010) | QUIC with TLS 1.3 (AES-GCM / ChaCha20-Poly1305, X25519, Ed25519) | rustls / quinn / iroh — **not** Apple's frameworks | End-to-end encryption of documents between the user's devices |
| `.selispack` with passphrase (ADR 0012) | Argon2id (RFC 9106) + XChaCha20-Poly1305 (published, IRTF CFRG draft; ChaCha20-Poly1305 is RFC 8439) | RustCrypto | Encrypting a file of the user's documents |
| PDF password protection (P4a, ADR 0015) | AES-256 (PDF 2.0 / ISO 32000-2), legacy RC4 / AES-128 to open old files | qpdf | Encrypting a PDF the user protects |
| Device identity (ADR 0011) | Ed25519 | ed25519-dalek | Authentication of devices (signatures) |
| Hashes | BLAKE3, SHA-256 | blake3, RustCrypto | Integrity |

All algorithms are published standards (IETF / ISO / IRTF); nothing proprietary. Selis is open
source (Apache-2.0), publicly available on GitHub.

## Apple's rules (checked 2026-10-14)

- `ITSAppUsesNonExemptEncryption`: "Set the value … to NO … to indicate that your app — including
  any third-party libraries you link against — either uses no encryption, or only uses encryption
  that's exempt … Set the value to YES to indicate that your app uses non-exempt encryption. If
  you set the value to YES, you typically also provide a value for the
  ITSEncryptionExportComplianceCode key" (<https://developer.apple.com/documentation/bundleresources/information-property-list/itsappusesnonexemptencryption>).
- "Typically, the use of encryption that's built into the operating system — for example, when
  your app makes HTTPS connections using URLSession — is exempt … whereas the use of proprietary
  encryption is not" (<https://developer.apple.com/documentation/security/complying-with-encryption-export-regulations>).
- Documentation required by type (<https://developer.apple.com/help/app-store-connect/reference/app-information/export-compliance-documentation-for-encryption>):
  - encryption limited to the Apple OS → none;
  - **"an industry standard algorithm, not provided within the Apple operating system" → the
    French encryption declaration, "only required if you're distributing your app on the App
    Store in France"**;
  - proprietary algorithms → CCATS + French declaration.
- France: "The import and export of encryption apps distributed in France are also controlled by
  the French Government … Secure Storage, Secure Communications" (ANSSI)
  (<https://developer.apple.com/help/app-store-connect/manage-app-information/overview-of-export-compliance>).
- US EAR: since the 29 March 2021 BIS rule, most mass-market items need no annual
  self-classification report and publicly available encryption source code needs no e-mail
  notification unless it implements non-standard cryptography (e.g.
  <https://www.thompsonhine.com/publications/bis-eliminates-most-mass-market-encryption-reporting-obligations>).

## Classification

Selis encrypts user data (transfers, packs, PDFs) with standard algorithms it carries itself
(rustls, RustCrypto, qpdf), not through Apple's OS. That is not the OS-only exemption and not
authentication-only, so in Apple's terms the app **uses non-exempt encryption of the "industry
standard algorithm" kind**. No CCATS. The only paperwork Apple can require is the French
declaration, and only for the French App Store.

**Correct value: `ITSAppUsesNonExemptEncryption` = `YES`.** Setting `NO` would be a false
declaration (the transfer and pack encryption are neither OS-provided nor authentication-only).

## Decision needed

| Option | What you do | Then in the repo |
| --- | --- | --- |
| **A — distribute in France** (recommended if France matters) | File the ANSSI "déclaration de fourniture d'un moyen de cryptologie" (free; ANSSI answers within a month), upload it in App Store Connect › App Information › App Encryption Documentation, Apple returns a code | `ITSAppUsesNonExemptEncryption` YES + `ITSEncryptionExportComplianceCode` = Apple's code; no questions at upload |
| **B — not in France** | Exclude France in App Store availability; answer "standard algorithms" + "not available in France" in App Store Connect | `ITSAppUsesNonExemptEncryption` YES; App Store Connect still asks the short questionnaire per build (or once Apple records the answer) |
| C — claim an exemption | — | Not recommended: the exemptions Apple lists do not cover encrypting user data with our own TLS / AEAD |

TestFlight internal testing needs the same answer before a build can be installed. Tell me A or
B; I add the key(s) to `project.yml` and `Info.plist` in the same commit.
