# ADR 0005 — IPC reliability: request ids, result store, recovery on resume

- Status: accepted
- Date: 2026-10-10

## Context

On Android (Tauri 2.11.6 / wry 0.55, emulator `selis-midrange-api36`), the reply of an IPC
call can be lost on its way back to the WebView while the activity resumes. Rust (or the Kotlin
plugin) finishes and resolves the call, but the JS promise never settles: the callback stays
registered in `window.__TAURI_INTERNALS__.callbacks` and `runCallback` never runs.

- First seen as "Importing…" forever after picking a file (3/20 cold-start imports; Dependabot
  PR #13 only made it visible — the rate was the same on `main`). docs/spike-p0.md, "Known issues".
- It is not specific to the dialog plugin. After the picker moved into our own `pick_pdf`
  command, the same loss hit that command's reply (recovered in 2 of 3 verification runs).
- The cause is upstream, inside the plugin/command → IPC → WebView path; we cannot fix it in
  the app. A UI that awaits an IPC promise with no exit hangs forever.

## Decision

All IPC goes through a reliability layer in `apps/app/src/lib/ipc/` that wraps — does not
replace — the generated tauri-specta bindings (`bindings.ts`). `lib/api.ts` is the only user.

**Long-running commands** (`import_document`, `pick_pdf`; every future save or transfer
command):

- The client generates a `request_id` (128 random bits, hex) per call.
- Rust runs the command through `RequestResults::run_once` (`src-tauri/src/requests.rs`): the
  final result — success or error, in the bindings' `Result` shape — is stored under the id in a
  bounded in-memory map: TTL 5 min after completion, at most 64 entries (expired first, then the
  oldest finished entry is evicted; running entries are never evicted, and a 65th running request
  is refused).
- **Idempotent per id:** a repeated call with the same id returns the stored result, or waits for
  the running one. It never runs the work (a write) again. An id reused for a different command
  is rejected.
- `take_result(request_id) → Pending | Done(result) | Unknown` is a fresh, read-only call that
  does not consume the entry, so a later duplicate is still answered from the store.
- The JS wrapper (`reliable.ts`) asks `take_result` for every in-flight request when the app is
  back in front (`visibilitychange` → visible, after a 1.5 s grace for the normal reply) and on a
  per-call deadline (import: after 5 s, then every 2 s while `Pending`; picker: on resume only,
  because the user may browse for minutes).
  - `Done` → settle with the stored result.
  - `Pending` → check again later. Rust bounds the work itself, e.g. the 30 s import deadline.
  - `Unknown` → the call never reached Rust (or has not registered yet): re-send it with the
    **same id** (safe because of idempotency). After a second `Unknown`, or if the request is
    older than the TTL (the result might have expired, so a re-send could run the command
    twice), it fails with `LostResponseError`.
  - A `take_result` call can be lost too: each one has a 3 s budget, and after 3 unanswered
    checks the call fails with `LostResponseError`.
- Callers map `LostResponseError` to a state with an exit: for import, the state machine's
  `resultLost`/`failed` error with "Try again" (`features/library/importMachine.ts`).

**Short commands** keep a plain 10 s timeout (`IpcTimeoutError`). Read-only ones (`list_documents`,
`read_document`, `get_settings`, `device_memory`) get a single retry. Short writes
(`update_settings`, `record_document_info`) are never repeated automatically.

The Tauri `RunEvent::Resumed` event is not used as a trigger. It reaches JS through the same
evaluate-JavaScript path that loses replies, and it would need extra event capabilities.
`visibilitychange` comes from the WebView itself.

The one-off picker recovery (`take_pick_result`, `PickerState`) was removed. `pick_pdf` is an
ordinary long-running command on this layer.

## Consequences

- New long-running commands must take `request_id: String`, wrap their body in
  `results.run_once(&request_id, "<command>", …)`, and be called through `ipc().long(…)` in
  `lib/api.ts`. A command whose work is not safe to dedupe by id does not belong on this path.
- Results are only in memory: if the process dies, the stored results go with it. Writes stay
  atomic (`selis_core::atomic_write`), so a lost process never leaves a partial file.
- Logcat shows each recovery (`[selis:ipc] <command>: reply lost, recovered via take_result`),
  so the upstream rate stays visible.
- Maestro covers the resume path (`e2e/maestro/import-background-resume.yaml`: picks a file,
  presses home, relaunches). `e2e/maestro/run.sh` fails a run on "ANR in com.anywecon.selis",
  because the emulator hides ANR dialogs.

## When it can be removed

When Tauri's Android IPC delivers every reply after a resume, the layer can go. That means a
Tauri/wry upgrade that passes all of these:

1. The minimal repro in docs/spike-p0.md "Known issues" (plain `create-tauri-app` with the dialog
   plugin) settles `open()` in 20/20 cold-start runs.
2. Our Maestro flows show **zero** `[selis:ipc] … reply lost` lines over 20+ runs of
   `import-scroll-back.yaml` and `import-background-resume.yaml`.

Even then, keep the request id + `run_once` for writes. Idempotent writes are worth having for
retries in their own right (P3 transfer, P2 saves). Only drop the resume and deadline polling in
`reliable.ts` and the short-call retries.
