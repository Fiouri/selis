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
#
# /proc/net/{udp,udp6,tcp,tcp6} list sockets with their owner UID (column 8); the
# app's UID comes from `pm list packages -U`.
set -euo pipefail

cmd="${1:?usage: transfer.sh sockets|sockets-open|check <serial> [sha256]}"
serial="${2:?serial}"
pkg=com.anywecon.selis
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
state="$root/.tmp/maestro-transfer"
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
    "$peer" send "$fixture" --yes --store "$state/store" > "$state/peer.log" 2>&1 &
    echo $! > "$state/peer.pid"
    for _ in $(seq 1 60); do grep -q '^LINK ' "$state/peer.log" && break; sleep 1; done
    link="$(sed -n 's/^LINK //p' "$state/peer.log" | tr -d '\r')"
    [ -n "$link" ] || { echo "FAIL: the peer printed no link" >&2; cat "$state/peer.log" >&2; exit 1; }
    # As the camera app would: the link opens Selis (cold start) on the Receive tab.
    adb_ shell am start -W -a android.intent.action.VIEW -d "'$link'" "$pkg" >/dev/null
    echo "OK: peer sending, link opened"
    ;;
  post)
    want="$(sha256sum "$fixture" | cut -d' ' -f1)"
    status=0
    "$0" check "$serial" "$want" || status=1
    # The flow left the Transfer screen: the endpoint must be gone.
    sleep 2
    "$0" sockets "$serial" || status=1
    grep -q '^done' "$state/peer.log" || { echo "FAIL: the peer did not finish" >&2; status=1; }
    [ -f "$state/peer.pid" ] && kill "$(cat "$state/peer.pid")" 2>/dev/null
    rm -rf "$state/store"
    exit "$status"
    ;;
  *)
    echo "unknown command $cmd" >&2
    exit 2
    ;;
esac
