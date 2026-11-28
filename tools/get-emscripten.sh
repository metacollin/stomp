#!/bin/sh
# Download the Emscripten build in tools/emscripten.lock, check it, unpack it in DIR
# (default ~/.cache/stomp-emscripten) and write its config. Then:
#   export PATH="DIR/install/emscripten:$PATH"
#   cmake --preset wasm-release && cmake --build --preset wasm-release
# Linux x86-64 only; elsewhere, install emsdk (https://emscripten.org) instead.
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lock="$here/emscripten.lock"
get() { sed -n "s/^$1=//p" "$lock"; }
url=$(get url)
sum=$(get sha256)
version=$(get version)
dir=${1:-"${XDG_CACHE_HOME:-$HOME/.cache}/stomp-emscripten"}

if [ -x "$dir/install/emscripten/emcc" ] && [ "$(cat "$dir/install/emscripten/emscripten-version.txt" 2>/dev/null)" = "$version" ]; then
  echo "Emscripten $version is already in $dir"
else
  mkdir -p "$dir"
  echo "Downloading Emscripten $version (about 260 MB)"
  curl -fL --retry 3 -o "$dir/wasm-binaries.tar.xz" "$url"
  echo "$sum  $dir/wasm-binaries.tar.xz" | sha256sum -c -
  rm -rf "$dir/install"
  tar -xJf "$dir/wasm-binaries.tar.xz" -C "$dir"
  rm -f "$dir/wasm-binaries.tar.xz"
fi

node=$(command -v node || true)
[ -n "$node" ] || { echo "Emscripten needs Node.js on the PATH" >&2; exit 1; }
cat > "$dir/install/emscripten/.emscripten" <<EOF
LLVM_ROOT = '$dir/install/bin'
BINARYEN_ROOT = '$dir/install'
NODE_JS = '$node'
EOF
"$dir/install/emscripten/emcc" --version | head -1
echo "Now: export PATH=\"$dir/install/emscripten:\$PATH\""
