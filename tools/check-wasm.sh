#!/bin/sh
# Check that demo/js/stomp-core.js, which is committed, is what the sources build: build
# the WebAssembly module afresh in build/wasm-check, writing its stomp-core.js there, and
# compare the two. Needs Emscripten on the PATH (tools/get-emscripten.sh).
#   tools/check-wasm.sh
set -eu
cd "$(dirname "$0")/.."
out=build/wasm-check
rm -rf "$out"
emcmake cmake --preset wasm-release -B "$out" -DSTOMP_WASM_OUT="$PWD/$out/stomp-core.js" > /dev/null
cmake --build "$out" > /dev/null
if cmp -s "$out/stomp-core.js" demo/js/stomp-core.js; then
  echo "demo/js/stomp-core.js matches a fresh build"
else
  echo "demo/js/stomp-core.js differs from a fresh build: run emcmake cmake --preset wasm-release && cmake --build --preset wasm-release" >&2
  exit 1
fi
