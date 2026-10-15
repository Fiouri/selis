# ADR 0027 — Android background transfers: user-initiated data transfer job (14+), untyped FGS below

- Status: accepted (supersedes the `dataSync` foreground service of ADR 0010)
- Date: 2026-10-15

## Context

A transfer the user starts must keep going when they leave the app (P3, ADR 0010). Selis used a
`dataSync` foreground service. Google Play asks apps targeting Android 14+ to declare every
foreground service type with a use case and a video, and recommends "the user-initiated data
transfer job instead of the dataSync foreground service type" for transfers the user starts
(Play Console Help 13392821, checked 2026-10-15). Android 15 also caps `dataSync` services at
6 h a day.

Android's API (developer.android.com/develop/background-work/background-tasks/uidt and the SDK 36
sources): a job with `setUserInitiated(true)` needs `RUN_USER_INITIATED_JOBS`, may only be
scheduled while the app is visible, must post its notification with
`JobService.setNotification` within 10 s of `onStartJob`, and on Android 14 must declare a
network constraint. `setRequiredNetworkType` always asks for *validated internet*; a LAN transfer
on a Wi-Fi without internet would never start.

## Decision

- **Android 14+**: `TransferJobService` (a `JobService`) is scheduled when the UI first reports
  progress of a running transfer (the app is on the Transfer screen, so visible). The transfer
  itself stays in Rust in the app process; the running job keeps the process alive and carries
  the progress notification (`JOB_END_NOTIFICATION_POLICY_REMOVE`). Network constraint: a
  `NetworkRequest` with all capabilities cleared (any network, LAN included). Estimated bytes at
  schedule time, transferred bytes reported on every update (`updateTransferredNetworkBytes`, so
  the system sees progress). `jobFinished` when the transfer ends or the Transfer screen closes.
  When the system stops the job (lost network, thermal, no progress) the UI pauses receives
  (`selis:transfer-timeout`, resumable) and the job is not rescheduled.
- **Android 8–13**: the existing foreground service, now **without a type** (types are enforced
  only from Android 14), with `FOREGROUND_SERVICE` limited to `maxSdkVersion="33"`. The manifest
  declares no `foregroundServiceType` and no `FOREGROUND_SERVICE_DATA_SYNC`, so Play's foreground
  service declaration (and its video) no longer applies.
- `transfer_foreground` now takes KiB and the direction (`upload`), so the job reports bytes.
- Testing aid (debug builds): `debug.selis.receive_kbps` paces receives (`ServiceConfig::
  receive_rate`), so `transfer-background.yaml` can keep a transfer running while the app sits in
  the background for 60 s; `transfer.sh post-background` checks from 5-second samples that the
  job ran and bytes kept arriving while Selis was not on top.

## Consequences

- A job started from the background is refused; the transfer still runs while the app is open,
  and the next progress update tries again. Starting a transfer always happens in the app.
- If the user stops the app from the Task Manager, Android kills the process without
  `onStopJob`; receives resume from the paused list on the next start (ADR 0010 resume).
- Android 8–13 behaviour is unchanged in practice but is not covered by a device test (no
  API ≤ 33 device or image with a WebView ≥ 111 here).
