#!/usr/bin/env bash
# Path-independent native builds (ADR 0021, F-Droid reproducible builds): absolute paths of the
# Cargo home (registry sources, including vendored C/C++ such as qpdf), the checkout and the NDK
# end up in panic messages and __FILE__ strings, so two builds of the same commit in different
# directories differ. Source this before `npm run tauri -- android build`:
#
#   . scripts/reproducible-env.sh
#
# - Rust: a `[target.'cfg(target_os = "android")'] rustflags` entry with --remap-path-prefix in
#   $CARGO_HOME/config.toml. Cargo joins cfg-target rustflags with the per-triple ones of the
#   project's .cargo/config.toml (16 KB page flags), and a RUSTFLAGS variable would replace them.
# - C/C++ (cc crate): -ffile-prefix-map in CFLAGS / CXXFLAGS.
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo_home="${CARGO_HOME:-$HOME/.cargo}"
ndk="${NDK_HOME:-}"
mkdir -p "$cargo_home"
config="$cargo_home/config.toml"
marker="# selis reproducible-env"
if ! grep -q "$marker" "$config" 2>/dev/null; then
  {
    echo ""
    echo "$marker"
    echo "[target.'cfg(target_os = \"android\")']"
    printf 'rustflags = ["--remap-path-prefix=%s=/cargo", "--remap-path-prefix=%s=/selis"' "$cargo_home" "$root"
    [ -n "$ndk" ] && printf ', "--remap-path-prefix=%s=/ndk"' "$ndk"
    echo "]"
  } >> "$config"
fi
maps="-ffile-prefix-map=$cargo_home=/cargo -ffile-prefix-map=$root=/selis"
[ -n "$ndk" ] && maps="$maps -ffile-prefix-map=$ndk=/ndk"
export CFLAGS="${CFLAGS:+$CFLAGS }$maps" CXXFLAGS="${CXXFLAGS:+$CXXFLAGS }$maps"
