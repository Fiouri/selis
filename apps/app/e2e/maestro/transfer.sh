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
  post)
    want="$(sha256sum "$fixture" | cut -d' ' -f1)"
    status=0
    "$0" check "$serial" "$want" || status=1
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
