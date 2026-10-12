# P3 transfer spike — iroh 1.3 + iroh-blobs 0.103 on Android (2026-10-12)

Risk-first check before building P3a: can an iroh endpoint run on the phones, reach a host peer
and move 200 MB with BLAKE3 verification? This also measures the path, throughput, memory and
resume.

**Setup**
- **Binary:** `crates/selis-transfer/examples/spike.rs`, cross-compiled as a plain Android binary
  (`scripts/android-build.sh spike <arch>`, profile `devtool`) and run from `adb shell`. It is
  not the app, and the RSS is of that process only.
- **Store:** `FsStore` in a scratch dir; the sender imports with `ImportMode::TryReference` (no copy).
- **Host:** Windows 11, Wi-Fi `192.168.1.2`, sender in every run.
- **Galaxy S23:** Wi-Fi `192.168.1.8` on the same network.
- **AVD:** `selis-midrange-api36`, behind the emulator's NAT.
- **Payload:** 200 MB of random bytes. Every run ended with the same SHA-256 on both ends
  (`eb21e549…`), and the iroh hash matched (`1dbb89bc…`).

| Receiver | Path (selected) | Time | Throughput | RSS start → peak |
| --- | --- | --- | --- | --- |
| S23, default (n0 relay + direct) | starts via relay `euc1-1.relay.n0.iroh.link`, switches to **direct** `192.168.1.2` | 5.9 s | **34.1 MB/s** | 4.7 → 17.0 MB |
| S23, relay only (`clear_ip_transports`) | **relay** `euc1-1` | 194 s | **1.0 MB/s** | 4.6 → 17.6 MB |
| AVD, default | **direct** (through the emulator NAT) | 56.8 s | 3.5 MB/s | 5.5 → 23.3 MB |
| S23, resume | relay; killed (`SIGKILL`) at 41 MB, restarted on the same store | 154.8 s for the rest | 1.0 MB/s | read **157 MB** (only the missing part) |

Host import of 200 MB by reference: 0.19 s. A debug build on the S23 reached 6.7 MB/s direct
with a 42 MB peak RSS: use optimized builds for measurements.

## Findings

1. **No blocker.** Binding, address lookup, the n0 relay, hole punching to a direct path, verified
   streaming and resume all work on Android 16 (S23) and on API 36 (AVD).
2. **iroh's DNS resolver reads Android's system DNS through JNI (`ndk-context`).** In a binary
   without an Android context, it panics and recovers through `catch_unwind`. Under
   `panic = "abort"` (our release profile) that recovery is impossible, so the process aborts.
   - **In the app:** tao (0.37) initializes the Android context at startup, so the call succeeds.
     The endpoint must only be created after that, which holds: it is created when the Transfer
     screen opens. This has to be verified on the device in the app build.
   - **Dev binaries:** they use the `devtool` profile (release + `panic = "unwind"`).
3. **The n0 public relay is slow (~1 MB/s).** 200 MB takes over 3 minutes. Fine as a fallback;
   it is documented in the UI copy ("slower") and in the privacy page.
4. **Memory is small.** The transfer itself adds about 12 MB RSS on the S23, far under the 60 MB
   budget.
5. **Licenses** (cargo-deny):
   - `webpki-roots` / `webpki-root-certs` are CDLA-Permissive-2.0 (the Mozilla CA bundle, a
     permissive data license); now allowed explicitly.
   - Three Unlicense crates are browser-only (wasm32). The deny graph is now limited to the
     targets Selis ships.

## In-app measurements (P3a, 2026-10-12)

The app itself (release + `measure` feature, debug-signed: optimized code with WebView DevTools on)
against the dev peer on the host (`selis-peer`, release), driven by
`node scripts/measure-transfer.ts` (Receive tab → paste link, or Send tab → QR link; the host
confirms only after comparing its code with the one on the device). Payload: a 200 MB PDF
(`%PDF-` header + random bytes). Host on Wi-Fi 192.168.1.2 (NordVPN active, as in the spike).
RSS: app process `TOTAL RSS` (dumpsys meminfo), peak during the transfer minus the value with the
Transfer screen already open. Release APK sizes: arm64 22.7 MB, x86_64 24.6 MB.

| Device | Direction | Route (UI chip) | Time / speed | RSS Δ | Same code | Integrity |
| --- | --- | --- | --- | --- | --- | --- |
| S23 (Android 16) | host → S23 | Same Wi‑Fi (`lan`) | 6.3 s, **36.9 MB/s** | ≤ 0 | ✓ | BLAKE3 in library ✓ |
| S23 | host → S23, host relay-only | relay | 200.9 s, **1.0 MB/s** | +18 MB | ✓ | ✓ |
| S23 | S23 → host | `direct` | 20.5 s, **11.1 MB/s** | +4 MB | ✓ | SHA-256 equal ✓ |
| S23 | S23 → host, host relay-only | relay | 201.9 s, **1.0 MB/s** | +3 MB | ✓ | ✓ |
| S23 | resume: `am force-stop` at 40 % | `lan` | resumed at **59 %** (what had reached the store), done 5.0 s after Resume | +17 MB | ✓ | ✓ |
| S23 | cold start from a `selis://` intent (camera-app path) | `lan` | 6.9 s launch → in library | – | – | ✓ |
| AVD `selis-midrange-api36` | host → AVD | `lan` (emulator NAT) | 54.3 s, 3.9 MB/s | +10 MB | ✓ | ✓ |
| AVD | host → AVD, relay-only | relay | 202.0 s, 1.0 MB/s | +4 MB | ✓ | ✓ |
| AVD | AVD → host | `lan`/`direct` | 47.2 s, 4.6 MB/s | +6 MB | ✓ | ✓ |
| AVD | AVD → host, relay-only | relay | 199.3 s, 1.0 MB/s | +9 MB | ✓ | ✓ |
| AVD | resume: `am force-stop` at 40 % | `lan` | resumed at 43 %, done 32.8 s later | +4 MB | ✓ | ✓ |

Refusals on devices: a ticket that lived 3 s → "expired" on S23 and AVD (local check); the link
already used by the S23 → "already used" on the AVD (sender's single-use token). An unconfirmed
peer fetching the blobs directly is refused by the gate (integration test, mutation-checked).
No socket owned by the app UID after a cold start, nor after leaving the Transfer screen
(`transfer.sh sockets`, S23 and AVD).

Findings:

1. **Device key bug found on the device:** two `register_android_plugin` calls in one Tauri plugin
   keep only the last handle, so `deviceKey` went to `TransferPlugin` and every start used a new
   identity; resume after a kill was then refused ("unknown session"). Fixed (own Tauri plugin),
   resume verified above.
2. **The notification-permission dialog blocked progress polling** (the UI awaited it). Fixed.
3. **One AVD → host direct run stalled** (~1 MB per 105 s, path flapping `lan`/`direct`, no relay
   fallback) and was stopped; the rerun reached 4.6 MB/s. Seen only through the emulator's NAT;
   watch for it on real networks (iroh path selection), the receiver can cancel and the transfer
   resumes.
4. Route labels: a direct path to the host's global IPv6 address shows "Direct connection", not
   "Same Wi‑Fi" (`lan` = private/link-local/ULA addresses only).
5. JNI DNS (finding 2 of the spike) does not abort in the app: the default network setting
   (n0 DNS + relay) worked in every run.
