#!/bin/sh
# Build the real hash tool: pure wasm32, no imports, no entry, memory exported.
#
# -Wl,--max-memory=33554432 declares a memory MAX (512 pages of 64 KiB = 32 MiB,
# CAP tier "tiny"): the authority discipline refuses a module whose memory
# ceiling is undeclared (memory_max_missing), so the build declares one.
set -e
clang --target=wasm32 -O2 -nostdlib \
  -Wl,--no-entry -Wl,--export-memory -Wl,--max-memory=33554432 \
  -Wl,--export=sha256 -Wl,--export=addresses \
  -o hash.wasm sha256.c
sha256sum hash.wasm
