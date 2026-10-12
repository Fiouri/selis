# Patched Maestro for WebView 15x

Maestro reads a WebView's DOM over Chrome DevTools (`androidWebViewHierarchy: devtools`).
In Maestro 2.11, the WebSocket request carries the DevTools socket name as its `Host` header
(`webview_devtools_remote_<pid>:9222`). Android System WebView 15x (the Galaxy S23 has 153)
refuses it with HTTP 500, because DevTools only serves `localhost` or IP hosts. Maestro then
falls back to the accessibility tree, and the Selis flows fail there: DOM ids are missing, and
sheets are read while they are still sliding. The AVD's WebView 133 accepts the request.

Maestro's HTTP request to the same server already sends `Host: localhost:9222`.
[`maestro-ws-host.patch`](maestro-ws-host.patch) adds the same header to the WebSocket request
(upstream source, tag `cli-2.11.0`). `MaestroHostPatch.java` applies that change to the release
jar's bytecode.

```sh
tools/maestro-patch/build.sh            # once; and again after changing MAESTRO_TAG
MAESTRO=F:/DevCache/maestro-selis/bin/maestro apps/app/e2e/maestro/run.sh RFCW510JNZB apps/app/e2e/maestro/redact.yaml
```

`build.sh` does the following:
1. Downloads the pinned release (`MAESTRO_TAG`) and checks its SHA-256.
2. Unpacks it into `F:/DevCache/maestro-selis`, or the folder given as the first argument.
3. Patches the class and writes `PATCHED` (tag, hash, patch).

The installed Maestro under `~/.maestro` is never modified. When upstream fixes the bug (draft
report: [docs/upstream/maestro-webview.md](../../docs/upstream/maestro-webview.md)), drop this
folder and use the stock CLI.
