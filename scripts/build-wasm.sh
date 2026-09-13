#!/usr/bin/env bash
# Build twin-wasm for the browser.
#
# Emits into web/public/wasm when the web app is present, otherwise into
# crates/twin-wasm/pkg, and says which.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

command -v wasm-pack >/dev/null 2>&1 || {
  echo "error   wasm-pack not found; install with: cargo install wasm-pack --locked" >&2
  exit 1
}

if [[ -d "$ROOT/web" ]]; then
  OUT="../../web/public/wasm"
else
  OUT="pkg"
  echo "note    web/ is absent; emitting to crates/twin-wasm/$OUT instead"
fi

wasm-pack build "$ROOT/crates/twin-wasm" --target web --out-dir "$OUT"

# The threaded variant, alongside. wasm-bindgen-rayon needs the atomics ABI,
# which means a std rebuilt for it, which means nightly. It is optional: skip
# it and the app runs the single-threaded build above.
if [[ "${SKIP_THREADED:-0}" == "1" ]]; then
  echo "note    SKIP_THREADED=1; not building the threaded variant"
  exit 0
fi
if ! rustup toolchain list 2>/dev/null | grep -q '^nightly'; then
  echo "note    no nightly toolchain; skipping the threaded build. Install with:"
  echo "        rustup toolchain install nightly --component rust-src --target wasm32-unknown-unknown"
  exit 0
fi
MT_OUT="${OUT}-mt"
# The exports are named explicitly because lld garbage-collects them, and
# wasm-bindgen's threading transform needs them to exist.
MT_FLAGS="-C target-feature=+atomics,+bulk-memory"
MT_FLAGS="$MT_FLAGS -C link-arg=--shared-memory -C link-arg=--max-memory=2147483648"
MT_FLAGS="$MT_FLAGS -C link-arg=--import-memory"
for sym in __wasm_init_tls __tls_size __tls_align __tls_base; do
  MT_FLAGS="$MT_FLAGS -C link-arg=--export=$sym"
done
RUSTFLAGS="$MT_FLAGS" rustup run nightly wasm-pack build "$ROOT/crates/twin-wasm" \
  --target web --out-dir "$MT_OUT" --features threads \
  -Z build-std=panic_abort,std
echo "note    threaded build in $MT_OUT; it needs COOP/COEP headers (see crates/twin-wasm/README.md)"
