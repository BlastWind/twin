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
