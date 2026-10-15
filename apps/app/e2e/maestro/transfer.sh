#!/usr/bin/env bash
# Transfer checks around the Maestro flows (ADR 0010).
#
#   transfer.sh sockets <serial>          app UID owns no UDP/TCP socket (cold start, library)
#   transfer.sh sockets-open <serial>     the Transfer screen is open: it owns at least one UDP socket
#   transfer.sh check <serial> <sha256>   a document with that SHA-256 arrived in the library,
#                                         and nothing is left in the transfer store's "in" folder
#   transfer.sh pre <serial>              (PRE_RUN of transfer.yaml) clears the app, checks a cold
#                                         start opens no socket, starts the dev peer sending a
#                                         fixture (auto-confirm) and opens its selis:// link (cold start)
#   transfer.sh post <serial>             (POST_RUN) the fixture is in the library, the Transfer
#                                         screen was left so no socket remains, stops the peer
#   transfer.sh pre-recover <serial>      (PRE_RUN of transfer-recover.yaml, debug build) clears the
#                                         app, makes offered codes expire after 60 s
#                                         (debug.selis.ticket_lifetime), starts the dev peer sending a
#                                         200 MB file that drops out once data flows, opens its link
#   transfer.sh post-recover <serial>     (POST_RUN) the peer dropped out, nothing was received or
#                                         left in the transfer inbox, no socket, switch cleared
#   transfer.sh pre-background <serial>   (PRE_RUN of transfer-background.yaml, debug build) clears
#                                         the app, paces receives to 1 MiB/s (debug.selis.receive_kbps),
#                                         starts the dev peer sending a 100 MB file, opens its link and
#                                         samples (every 5 s) which app is on top, the transfer store
#                                         progress (MB sent) and whether the user-initiated job
#                                         (Android 14+) or the foreground service (below) runs
#   transfer.sh post-background <serial>  (POST_RUN) ≥ 55 s in the background with the job or the
#                                         service running and ≥ 30 MB sent meanwhile; the file is
#                                         in the library intact; no job, service, notification or
#                                         socket left
#
# /proc/net/{udp,udp6,tcp,tcp6} list sockets with their owner UID (column 8); the
# app's UID comes from `pm list packages -U`.
set -euo pipefail

cmd="${1:?usage: transfer.sh sockets|sockets-open|check <serial> [sha256]}"
serial="${2:?serial}"
pkg=com.anywecon.selis
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
state="$root/.tmp/maestro-transfer/$serial"
fixture="$root/packages/fixtures/out/greek.pdf"
adb_() { MSYS_NO_PATHCONV=1 adb -s "$serial" "$@"; }

# What keeps a transfer alive in the background (ADR 0027): from Android 14 the user-initiated
# data transfer job, below it the foreground service. Prints 1 if it is running, else 0.
keepalive_running() {
  if [ "$(adb_ shell getprop ro.build.version.sdk | tr -d '\r')" -ge 34 ]; then
    adb_ shell dumpsys jobscheduler "$pkg" 2>/dev/null | tr -d '\r' |
      awk '/^Active jobs:/ { a = 1; next } a && /^[^ ]/ { a = 0 } a && /TransferJobService/ { n++ } END { print (n > 0) ? 1 : 0 }'
  else
    adb_ shell dumpsys activity services "$pkg/.TransferForegroundService" 2>/dev/null | tr -d '\r' |
      awk '/ServiceRecord/ { s = 1 } s && /isForeground=true/ { n++ } END { print (n > 0) ? 1 : 0 }'
  fi
}

uid_of() {
  adb_ shell pm list packages --user 0 -U "$pkg" | tr -d '\r' | sed -n "s/^package:$pkg uid:\([0-9]*\).*/\1/p"
}

# Sockets owned by the app UID: "<table> <local address> <state>".
sockets() {
  local uid="$1"
  for table in udp udp6 tcp tcp6; do
    adb_ shell cat "/proc/net/$table" 2>/dev/null | tr -d '\r' | awk -v uid="$uid" -v t="$table" 'NR > 1 && $8 == uid { print t, $2, $4 }'
  done
}

# The peer of an earlier run whose flow failed (POST_RUN runs only after a pass) still
# holds its store: stop it before starting another.
stop_peer() {
  if [ -f "$state/peer.pid" ]; then
    kill "$(cat "$state/peer.pid")" 2>/dev/null || true
    rm -f "$state/peer.pid"
    sleep 1
  fi
}

case "$cmd" in
  sockets)
    uid="$(uid_of)"
    [ -n "$uid" ] || { echo "FAIL: $pkg not installed" >&2; exit 1; }
    found="$(sockets "$uid")"
    if [ -n "$found" ]; then
      echo "FAIL: the app (uid $uid) has sockets outside the Transfer screen:" >&2
      echo "$found" >&2
      exit 1
    fi
    echo "OK: no sockets for uid $uid"
    ;;
  sockets-open)
    uid="$(uid_of)"
    found="$(sockets "$uid")"
    echo "$found" | grep -q '^udp' || { echo "FAIL: Transfer screen open but no UDP socket (uid $uid)" >&2; exit 1; }
    echo "OK: endpoint sockets while open:"
    echo "$found"
    ;;
  check)
    want="${3:?sha256 of the sent file}"
    files="$(adb_ shell run-as "$pkg" sh -c "'ls files/library/*.pdf 2>/dev/null; ls /data/data/$pkg/library/*.pdf 2>/dev/null'" | tr -d '\r' || true)"
    hit=""
    for f in $files; do
      sum="$(adb_ shell run-as "$pkg" sha256sum "$f" | tr -d '\r' | cut -d' ' -f1)"
      [ "$sum" = "$want" ] && hit="$f"
    done
    [ -n "$hit" ] || { echo "FAIL: no library file with sha256 $want" >&2; exit 1; }
    left="$(adb_ shell run-as "$pkg" sh -c "'ls cache/transfer/in 2>/dev/null'" | tr -d '\r' || true)"
    [ -z "$left" ] || { echo "FAIL: transfer store still holds: $left" >&2; exit 1; }
    echo "OK: received $hit ($want), transfer inbox empty"
    ;;
  pre)
    mkdir -p "$state"
    [ -f "$fixture" ] || { echo "run npm run fixtures first ($fixture)" >&2; exit 2; }
    peer="$root/target/release/examples/selis-peer"
    [ -x "$peer" ] || [ -x "$peer.exe" ] || { echo "build it: cargo build --release -p selis-transfer --example selis-peer" >&2; exit 2; }
    [ -x "$peer.exe" ] && peer="$peer.exe"
    adb_ shell pm clear "$pkg" >/dev/null
    adb_ shell pm grant "$pkg" android.permission.POST_NOTIFICATIONS
    # A cold start (library only) opens no socket.
    adb_ shell am start -W -n "$pkg/.MainActivity" >/dev/null
    sleep 5
    "$0" sockets "$serial"
    adb_ shell am force-stop "$pkg"
    stop_peer
    rm -rf "$state/store"
    rm -f "$state/peer.log"
    # The peer is a native program: on Windows (Git Bash, MSYS_NO_PATHCONV) give it Windows paths.
    native() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
    "$peer" send "$(native "$fixture")" --yes --store "$(native "$state/store")" > "$state/peer.log" 2>&1 &
    echo $! > "$state/peer.pid"
    for _ in $(seq 1 60); do grep -q '^LINK ' "$state/peer.log" && break; sleep 1; done
    link="$(sed -n 's/^LINK //p' "$state/peer.log" | tr -d '\r')"
    [ -n "$link" ] || { echo "FAIL: the peer printed no link" >&2; cat "$state/peer.log" >&2; exit 1; }
    # As the camera app would: the link opens Selis (cold start) on the Receive tab.
    adb_ shell am start -W -a android.intent.action.VIEW -d "'$link'" "$pkg" >/dev/null
    echo "OK: peer sending, link opened"
    ;;
  pre-recover)
    mkdir -p "$state"
    peer="$root/target/release/examples/selis-peer"
    [ -x "$peer.exe" ] && peer="$peer.exe"
    [ -x "$peer" ] || { echo "build it: cargo build --release -p selis-transfer --example selis-peer" >&2; exit 2; }
    native() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
    payload="$state/vanishing-200mb.pdf"
    if [ ! -f "$payload" ]; then
      { printf '%%PDF-1.7\n'; head -c 200000000 /dev/urandom; printf '\n%%%%EOF\n'; } > "$payload"
    fi
    adb_ shell pm clear "$pkg" >/dev/null
    adb_ shell pm grant "$pkg" android.permission.POST_NOTIFICATIONS
    adb_ shell setprop debug.selis.ticket_lifetime 60
    stop_peer
    rm -rf "$state/store-recover"
    rm -f "$state/peer-recover.log"
    "$peer" send "$(native "$payload")" --yes --drop-after-accept --store "$(native "$state/store-recover")" > "$state/peer-recover.log" 2>&1 &
    echo $! > "$state/peer.pid"
    # Importing 200 MB into the peer's store takes a while on a busy disk.
    for _ in $(seq 1 180); do grep -q '^LINK ' "$state/peer-recover.log" && break; sleep 1; done
    link="$(sed -n 's/^LINK //p' "$state/peer-recover.log" | tr -d '\r')"
    [ -n "$link" ] || { echo "FAIL: the peer printed no link" >&2; kill "$(cat "$state/peer.pid")" 2>/dev/null; exit 1; }
    adb_ shell am start -W -a android.intent.action.VIEW -d "'$link'" "$pkg" >/dev/null
    echo "OK: vanishing peer sending, link opened"
    ;;
  pre-background)
    # transfer-background.yaml (debug build): a paced 100 MB receive, sampled every 5 s.
    mkdir -p "$state"
    peer="$root/target/release/examples/selis-peer"
    [ -x "$peer.exe" ] && peer="$peer.exe"
    [ -x "$peer" ] || { echo "build it: cargo build --release -p selis-transfer --example selis-peer" >&2; exit 2; }
    native() { if command -v cygpath > /dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
    payload="$state/background-100mb.pdf"
    if [ ! -f "$payload" ]; then
      { printf '%%PDF-1.7\n'; head -c 100000000 /dev/urandom; printf '\n%%%%EOF\n'; } > "$payload"
    fi
    sha256sum "$payload" | cut -d' ' -f1 > "$state/background.sha256"
    adb_ shell pm clear "$pkg" >/dev/null
    adb_ shell pm grant "$pkg" android.permission.POST_NOTIFICATIONS
    # First start after the clear (database, WebView) before the link, as `pre` does.
    adb_ shell am start -W -n "$pkg/.MainActivity" >/dev/null
    sleep 5
    adb_ shell am force-stop "$pkg"
    # 1 MiB/s: about 100 s for the file, so it is still running after 60 s in the background.
    adb_ shell setprop debug.selis.receive_kbps 1024
    stop_peer
    [ -f "$state/sampler.pid" ] && { kill "$(cat "$state/sampler.pid")" 2>/dev/null || true; rm -f "$state/sampler.pid"; }
    rm -rf "$state/store-background"
    rm -f "$state/peer-background.log" "$state/background-samples.txt"
    "$peer" send "$(native "$payload")" --yes --store "$(native "$state/store-background")" > "$state/peer-background.log" 2>&1 &
    echo $! > "$state/peer.pid"
    for _ in $(seq 1 180); do grep -q '^LINK ' "$state/peer-background.log" && break; sleep 1; done
    link="$(sed -n 's/^LINK //p' "$state/peer-background.log" | tr -d '\r')"
    [ -n "$link" ] || { echo "FAIL: the peer printed no link" >&2; kill "$(cat "$state/peer.pid")" 2>/dev/null; exit 1; }
    # Samples: <epoch s> <selis on top 1|0> <MB the sender has sent (its progress lines)>
    # <transfer job or foreground service running 1|0>. The sender's count, not the receiver's store: f2fs (the S23)
    # allocates written blocks late, so `du` there lags by tens of seconds.
    (
      set +e
      while true; do
        top="$(adb_ shell dumpsys activity activities 2>/dev/null | tr -d '\r' | grep -m1 -E 'topResumedActivity|mResumedActivity' || true)"
        case "$top" in *"$pkg/"*) on_top=1 ;; *) on_top=0 ;; esac
        mib="$(grep -E '^[0-9]+ / [0-9]+ MB' "$state/peer-background.log" 2>/dev/null | tail -1 | cut -d' ' -f1)"
        job="$(keepalive_running)"
        echo "$(date +%s) $on_top ${mib:-0} $job" >> "$state/background-samples.txt"
        sleep 5
      done
    ) > /dev/null 2>&1 &
    echo $! > "$state/sampler.pid"
    adb_ shell am start -W -a android.intent.action.VIEW -d "'$link'" "$pkg" >/dev/null
    echo "OK: paced peer sending, link opened, sampling"
    ;;
  post-background)
    status=0
    [ -f "$state/sampler.pid" ] && { kill "$(cat "$state/sampler.pid")" 2>/dev/null || true; rm -f "$state/sampler.pid"; }
    adb_ shell setprop debug.selis.receive_kbps "''"
    samples="$state/background-samples.txt"
    # The longest stretch with Selis not on top, and what happened during it.
    read -r away grew jobs total < <(awk '
      $2 == 0 { if (!run) { run = 1; t0 = $1; k0 = $3; j = 0; n = 0 } t1 = $1; k1 = $3; n++; j += $4 }
      $2 == 1 && run { if (t1 - t0 > best) { best = t1 - t0; g = k1 - k0; bj = j; bn = n } run = 0 }
      END { if (run && t1 - t0 > best) { best = t1 - t0; g = k1 - k0; bj = j; bn = n } print best + 0, g + 0, bj + 0, bn + 0 }
    ' "$samples")
    sdk="$(adb_ shell getprop ro.build.version.sdk | tr -d '\r')"
    what="transfer job"; [ "$sdk" -ge 34 ] || what="foreground service"
    echo "background (API $sdk): ${away} s, ${grew} MB sent meanwhile, $what running in ${jobs}/${total} samples"
    [ "$away" -ge 55 ] || { echo "FAIL: Selis was in the background only ${away} s" >&2; status=1; }
    [ "$grew" -ge 30 ] || { echo "FAIL: only ${grew} MB arrived while in the background" >&2; status=1; }
    if [ "$jobs" -lt $((total * 3 / 4)) ]; then
      echo "FAIL: the $what ran in only ${jobs}/${total} background samples" >&2; status=1
    fi
    "$0" check "$serial" "$(cat "$state/background.sha256")" || status=1
    sleep 2
    "$0" sockets "$serial" || status=1
    [ "$(keepalive_running)" -eq 0 ] || { echo "FAIL: the $what still runs" >&2; status=1; }
    adb_ shell dumpsys notification --noredact 2>/dev/null | tr -d '\r' | grep -q "pkg=$pkg .*id=7301" && { echo "FAIL: the transfer notification is still shown" >&2; status=1; }
    # The library file above is what counts. A connection the sender saw drop (iroh rebinding
    # its sockets, e.g. when the app returns) is resumed by the receiver; say so, don't fail.
    grep -q '^done' "$state/peer-background.log" ||
      echo "note: the sender reports '$(grep -E '^interrupted' "$state/peer-background.log" | tail -1)'; the receive resumed and finished intact"
    stall="$(awk '$2 == 0 { if ($3 == k && k > 0) { s += t ? $1 - t : 0 } else { s = 0 } if (s > m) m = s; k = $3; t = $1 }
      $2 == 1 { k = 0; t = 0; s = 0 } END { print m + 0 }' "$samples")"
    echo "longest stall in the background: ${stall} s"
    [ -f "$state/peer.pid" ] && kill "$(cat "$state/peer.pid")" 2>/dev/null || true
    rm -rf "$state/store-background"
    [ "$status" -eq 0 ] && echo "OK: the receive went on in the background and finished intact"
    exit "$status"
    ;;
  post-recover)
    status=0
    adb_ shell setprop debug.selis.ticket_lifetime "''"
    grep -q '^dropping out' "$state/peer-recover.log" || { echo "FAIL: the peer never dropped out" >&2; status=1; }
    left="$(adb_ shell run-as "$pkg" sh -c "'ls cache/transfer/in 2>/dev/null'" | tr -d '\r' || true)"
    [ -z "$left" ] || { echo "FAIL: transfer inbox still holds: $left" >&2; status=1; }
    sleep 2
    "$0" sockets "$serial" || status=1
    [ -f "$state/peer.pid" ] && kill "$(cat "$state/peer.pid")" 2>/dev/null || true
    rm -rf "$state/store-recover"
    [ "$status" -eq 0 ] && echo "OK: gave up on the vanished sender cleanly"
    exit "$status"
    ;;
  post | post-release)
    want="$(sha256sum "$fixture" | cut -d' ' -f1)"
    status=0
    # post-release: a release build is not debuggable (no run-as): the library check is skipped.
    [ "$cmd" = post ] && { "$0" check "$serial" "$want" || status=1; }
    # The flow left the Transfer screen: the endpoint must be gone.
    sleep 2
    "$0" sockets "$serial" || status=1
    grep -q '^done' "$state/peer.log" || { echo "FAIL: the peer did not finish" >&2; status=1; }
    [ -f "$state/peer.pid" ] && kill "$(cat "$state/peer.pid")" 2>/dev/null || true
    rm -rf "$state/store"
    exit "$status"
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac
