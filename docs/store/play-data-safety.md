# Google Play — Data safety (draft)

Draft answers for the Play Console "Data safety" form (updated for 1.0: transfer, scan, OCR,
images), checked 2026-10-14 against <https://support.google.com/googleplay/android-developer/answer/10787469>.
Source of truth for the behaviour: docs/PRIVACY.md, ADRs 0010–0013, 0016–0018. Review before
each release that changes networking, permissions or SDKs. Other App content answers:
`play-console.md`.

## Data collection and security

| Question | Answer | Why |
| --- | --- | --- |
| Does your app collect or share any of the required user data types? | **No** | Selis sends no data to us or to third parties. Documents go only to the user's own other device, chosen by the user, end-to-end encrypted. |
| Is all of the user data collected by your app encrypted in transit? | Yes (n/a: nothing is collected) | Transfers use QUIC + TLS 1.3. |
| Do you provide a way for users to request that their data is deleted? | n/a — nothing is collected; all data is on the device and deleted with the app. | |

### Notes for the reviewer / form

- **User-initiated transfer to the user's own device** is not "sharing" in Play's definition when
  the user explicitly initiates it to a recipient they choose and the developer does not receive
  the data ("transferred … as part of a user-initiated action … to a destination the user chooses").
- **Relay (n0):** encrypted packets and the IP address pass through n0's public relay only when
  no direct path exists; n0 cannot read content and Selis has no data agreement with n0. Users
  can disable it (Local network only) or use their own relay. Mention in the privacy policy
  (docs/PRIVACY.md), not as collection by Selis.
- **No SDKs that collect data:** no analytics, crash reporting, ads, or Google ML Kit
  (QR scanning is on-device with jsQR, ADR 0013).
- **Camera:** QR codes and document scan. Frames are processed on the device only; a scanned
  page is kept only in the PDF the user saves, never sent → not collected (ADR 0013, 0016).
- **Photos:** picked through the system photo picker (no media permission); photo metadata
  (EXIF, GPS) is dropped when the PDF is made; nothing is sent → not collected (ADR 0017).
- **Text recognition (OCR):** Tesseract and its models ship in the app and run on the device;
  nothing is downloaded or sent → not collected (ADR 0018).
- **`.selispack` export:** a file the user creates and hands to an app of their choice through the
  system share sheet; Selis does not transmit it and receives nothing → not collected or shared
  by Selis. The optional passphrase is never stored. "Encrypted in transit" does not apply to a
  plain (no passphrase) pack the user sends elsewhere: say so in the privacy policy (done).
- **Device identity key:** generated and kept on the device (Android Keystore), never sent → not
  collected. The public key is visible to the device you transfer with and to the relay.

## Permissions declared (manifest) and their justification

| Permission | Justification (store listing / review) |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Device-to-device transfer, only while the Transfer screen is open |
| `CHANGE_WIFI_MULTICAST_STATE` | Discover the user's other device on the same Wi‑Fi (mDNS) |
| `CAMERA` (feature not required) | Scan the transfer QR code; photograph document pages (scan) |
| `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_DATA_SYNC` | A transfer the user started continues when the app is in the background |
| `POST_NOTIFICATIONS` | Progress notification of that transfer |

**Foreground service declaration (Play Console › App content › Foreground service permissions):**
type `dataSync`; task: "Transferring documents between the user's own devices, started by the
user, with a visible progress notification; stops when the transfer ends or is cancelled."
Video of the flow required by Play: record Send → QR → code → progress notification.

## Open points before submission

- Privacy policy URL must host docs/PRIVACY.md.
- `targetSdk` 37 (Android 17) will need `ACCESS_LOCAL_NETWORK` (CI guard in place).
- Re-check this form if a relay of our own is ever operated (we would then process IP addresses).
