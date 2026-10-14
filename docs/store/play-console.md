# Google Play Console — App content answers (draft)

Drafts for Play Console › Policy › App content, checked 2026-10-14. Data safety:
`play-data-safety.md`. Behaviour source: docs/PRIVACY.md and the ADRs named below. Re-check
before each release that changes networking, permissions or SDKs.

## Privacy policy

URL: `https://fiouri.github.io/selis/privacy/` (website/, generated from docs/PRIVACY.md; Greek at
`/el/privacy/`). Play requires a public, non-PDF, non-geofenced page
(<https://support.google.com/googleplay/android-developer/answer/10144311>).

## App access

All functionality is available without special access (no login, no account).

## Ads

"No, my app does not contain ads."

## Content rating (IARC questionnaire)

Category: **All Other App Types** (utility / productivity). Answers:

| Question area | Answer | Note |
| --- | --- | --- |
| Violence, fear, sexuality, nudity, language, controlled substances, crude humour | No | The app shows only the user's own documents |
| Gambling / simulated gambling | No | |
| Users can interact or exchange content | **Yes** | Transfer sends documents to another device whose user scans the QR code or opens the link (often the user's own device, but it can be someone else's). No chat, no public profiles, no accounts, no content moderation needed |
| Shares the user's current physical location with other users | No | |
| Allows users to purchase digital goods | No | |
| Unrestricted internet access (browser, search engine) | No | Links in a PDF open in the system browser only when tapped (as any app hands a link to the browser) |
| Is the app a web browser or search engine | No | |

Expected result: lowest age rating in every region (e.g. PEGI 3 / ESRB Everyone) with the
"Users Interact" interactive element.

## Target audience and content

Target age groups: **13–15, 16–17, 18 and over** (not designed for children; choosing under 13
would put the app under the Families policy). The store listing does not target children.

## News, government, financial, health apps

Not a news app; not a government app; no financial features; no health features.

## Foreground service permissions (Android 14+)

Play: each foreground service type needs a description, the user impact if it is deferred or
interrupted, a use case and a video link
(<https://support.google.com/googleplay/android-developer/answer/13392821>).

- **Type:** `dataSync` (`TransferPlugin.kt`, ADR 0010).
- **Use case:** "Network transfer: Upload or download".
- **Description:** "Selis transfers PDF documents between the user's devices, directly or
  through a relay, end-to-end encrypted. The user starts each transfer on the Transfer screen
  and confirms a 6-digit code. While it runs, a notification shows the progress and a Cancel
  action; the service stops as soon as the transfer finishes, fails or is cancelled. The service
  is never started in the background or without a user action."
- **Impact if deferred:** "The transfer the user just started would not begin until the user
  returns to the app, and the other device would wait or time out (the transfer code is valid
  for 10 minutes)."
- **Impact if interrupted:** "A large transfer stops half-way; Selis can resume it, but the user
  has to reopen the app on both devices and wait again."
- Play suggests a user-initiated data transfer job for user-started network transfers; the
  transfer here is a long-lived peer-to-peer QUIC session that both devices must keep open
  together, which a job the system may defer or stop does not provide. Keep this answer ready
  if review asks.

### Demo video (≤ 1 minute, unlisted YouTube link)

Record on a phone with screen recording (no personal documents; use the sample PDFs):

1. Open Selis › Transfer › Send, pick two sample PDFs, the QR code appears (0:00–0:10).
2. On a second device: Transfer › Receive › Scan QR code; both screens show the same 6-digit
   code; tap Confirm on the sender (0:10–0:25).
3. Press Home on the sender while the transfer runs: the progress notification is visible in the
   shade, with Cancel (0:25–0:40).
4. The transfer completes, the notification disappears, the documents are in the receiver's
   library (0:40–0:55).

## Data safety

See `play-data-safety.md` ("No data collected", relay IP note).

## Permissions declarations

No sensitive permissions that need a declaration form (no SMS, call log, location, all-files
access, accessibility, VPN). Camera, notifications and the foreground service are explained in
the listing and the privacy policy.
