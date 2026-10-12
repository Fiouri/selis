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
