#!/usr/bin/env bash
#
# Build the Python engine and stage it where Tauri expects a sidecar.
#
# Tauri's `externalBin` entry "binaries/yame-engine" resolves to
# "binaries/yame-engine-<target-triple>" at build time, so the PyInstaller
# output is copied under that name. Run this before `tauri build`; `pnpm run
# package` does it for you.
#
# Usage:
#   scripts/build-sidecar.sh              # host target triple
#   scripts/build-sidecar.sh <triple>     # cross-compiling (needs that Python)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT/../mp3-metadata-api"
BIN_DIR="$ROOT/src-tauri/binaries"
NAME="yame-engine"

TRIPLE="${1:-$(rustc -vV | awk '/^host: /{print $2}')}"
if [[ -z "$TRIPLE" ]]; then
  echo "Could not determine the target triple; pass it as the first argument." >&2
  exit 1
fi

if [[ ! -d "$API_DIR" ]]; then
  echo "Engine source not found at $API_DIR" >&2
  exit 1
fi

PYTHON="$API_DIR/.venv/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  PYTHON="python3"
fi

echo "==> Building the engine with PyInstaller"
(
  cd "$API_DIR"
  "$PYTHON" -m PyInstaller yame-engine.spec --noconfirm --distpath dist --workpath build
)

BUILT="$API_DIR/dist/$NAME"
if [[ ! -f "$BUILT" ]]; then
  echo "PyInstaller did not produce $BUILT" >&2
  exit 1
fi

mkdir -p "$BIN_DIR"
cp "$BUILT" "$BIN_DIR/$NAME-$TRIPLE"
chmod +x "$BIN_DIR/$NAME-$TRIPLE"

echo "==> Sidecar staged: src-tauri/binaries/$NAME-$TRIPLE ($(du -h "$BIN_DIR/$NAME-$TRIPLE" | cut -f1))"
