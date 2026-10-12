#!/usr/bin/env bash
# Cross-compiles a selis-transfer example as a plain Android binary (dev only:
# run from `adb shell` under /data/local/tmp, never bundled).
#
#   crates/selis-transfer/scripts/android-build.sh <example> <aarch64|x86_64>
#
# Needs the NDK (NDK_HOME, or the SDK's ndk/27.3.13750724) and the rustup target.
set -euo pipefail
example="${1:?usage: android-build.sh <example> <aarch64|x86_64>}"
arch="${2:?usage: android-build.sh <example> <aarch64|x86_64>}"
ndk="${NDK_HOME:-$LOCALAPPDATA/Android/Sdk/ndk/27.3.13750724}"
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) host=windows-x86_64; ext=.cmd ;;
  Darwin) host=darwin-x86_64; ext= ;;
  *) host=linux-x86_64; ext= ;;
esac
bin="$ndk/toolchains/llvm/prebuilt/$host/bin"
target="$arch-linux-android"
api=24
up="$(echo "$target" | tr 'a-z-' 'A-Z_')"
low="$(echo "$target" | tr '-' '_')"
export "CARGO_TARGET_${up}_LINKER=$bin/$target$api-clang$ext"
export "CC_${low}=$bin/$target$api-clang$ext"
export "CXX_${low}=$bin/$target$api-clang++$ext"
export "AR_${low}=$bin/llvm-ar"
profile="${PROFILE:-release}"
cargo build -p selis-transfer --example "$example" --profile "$profile" --target "$target"
echo "built target/$target/${profile/dev/debug}/examples/$example"
