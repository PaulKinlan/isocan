#!/bin/sh
# Build the real hash tool: pure wasm32, no imports, no entry, memory exported.
set -e
clang --target=wasm32 -O2 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory \
  -Wl,--export=sha256 -Wl,--export=addresses \
  -o hash.wasm sha256.c
sha256sum hash.wasm
