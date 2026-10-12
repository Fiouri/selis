<!-- Draft of an upstream issue for mobile-dev-inc/Maestro. Not posted. -->

# Android WebView hierarchy (devtools) fails on WebView 15x: WebSocket `Host` is the socket name → HTTP 500

**Maestro:** 2.11.0 (`cli-2.11.0`)
**Device:** Galaxy S23 (SM-S911B), Android 16, Android System WebView 153.0.8010.36
**Works on:** emulator with WebView 133.0.6943.137

## What happens

With `androidWebViewHierarchy: devtools`, every hierarchy read logs:

```
WARN maestro.Maestro.getWebViewTreeNodes: Failed to retrieve WebView hierarchy from chrome devtools:
webview_devtools_remote_16337 ws://localhost:9222/devtools/page/019C825AE3F1D34844EA4C8086A35F08
java.net.ProtocolException: Expected HTTP 101 response but was '500 Internal Server Error'
```

Maestro then falls back to the UiAutomator tree. Selectors that rely on DOM ids fail, and so do
taps on content that is still animating.

## Cause

`DadbChromeDevToolsClient.makeRequest` rewrites the URL host to the socket name
(`.host(socketName)`), so the custom socket factory can reach the abstract socket. OkHttp then sends
`Host: webview_devtools_remote_<pid>:9222`. Chrome's DevTools HTTP handler serves only requests
whose `Host` is an IP address or `localhost`, and answers anything else with 500 ("Host header is
specified and is not an IP address or localhost"). Recent WebView versions apply this check to the
WebSocket upgrade as well. The plain HTTP request (`/json/list`) already sets
`.header("Host", "localhost:9222")`, which is why page discovery works and only the WebSocket fails.

Reproduction without Maestro (`adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`):

```
curl -i -H "Host: foo:9222" -H "Connection: Upgrade" -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://localhost:9333/devtools/page/<id>           → HTTP/1.1 500 Internal Server Error
(same with -H "Host: localhost:9222")                → HTTP/1.1 101 WebSocket Protocol Handshake
```

## Fix

Set the same header on the WebSocket request in `makeSingleWebsocketRequest`:

```diff
             Request.Builder()
                 .url(url)
+                .header("Host", "localhost:9222") // Expected by devtools server
                 .build(),
```

With this change applied to the 2.11.0 jar, our 12 WebView flows pass on the S23 (and still on the emulator).
