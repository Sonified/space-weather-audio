#!/bin/bash
# Build script for custom KissFFT WASM binary
# Requires: Emscripten (emcc) — install via: brew install emscripten
#
# Produces: wasm/kissfft.wasm (standalone WASM, no JS glue needed)
#
# Usage: cd wasm && ./build.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$SCRIPT_DIR/src"
OUT_DIR="$SCRIPT_DIR"

echo "Building KissFFT WASM..."
echo "  Source: $SRC_DIR"
echo "  Output: $OUT_DIR/kissfft.wasm"

emcc \
    "$SRC_DIR/spectrogram_fft.c" \
    "$SRC_DIR/kiss_fft.c" \
    "$SRC_DIR/kiss_fftr.c" \
    -O3 \
    -msimd128 \
    -s WASM=1 \
    -s STANDALONE_WASM=0 \
    -s EXPORTED_FUNCTIONS='["_fft_single","_fft_batch_magnitudes","_fft_batch_uint8","_generate_hann_window","_wasm_malloc","_wasm_free","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='[]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=16777216 \
    -s TOTAL_STACK=1048576 \
    -s FILESYSTEM=0 \
    -s ENVIRONMENT='worker' \
    --no-entry \
    -o "$OUT_DIR/kissfft.wasm"

WASM_SIZE=$(wc -c < "$OUT_DIR/kissfft.wasm" | tr -d ' ')
echo "Done! kissfft.wasm = ${WASM_SIZE} bytes ($(echo "scale=1; $WASM_SIZE / 1024" | bc) KB)"
