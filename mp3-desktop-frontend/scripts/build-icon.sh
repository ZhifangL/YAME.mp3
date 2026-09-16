#!/usr/bin/env bash
#
# Regenerate the app icon from the frontend's favicon.
#
# The icon IS the favicon (scaled), so the two never drift: this extracts the
# live <svg> from public/favicon.svg, renders it at 1024x1024 with headless
# Chrome, and hands the result to Tauri's icon generator.
#
# Usage:  bash scripts/build-icon.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAVICON="$ROOT/public/favicon.svg"
SVG="$ROOT/src-tauri/app-icon.svg"
PNG="$ROOT/src-tauri/app-icon.png"
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

[[ -f "$FAVICON" ]] || { echo "No favicon at $FAVICON" >&2; exit 1; }

echo "==> Deriving src-tauri/app-icon.svg from public/favicon.svg"
python3 - "$FAVICON" "$SVG" <<'PY'
import pathlib, re, sys

src, dst = pathlib.Path(sys.argv[1]).read_text(), pathlib.Path(sys.argv[2])
# Drop commented-out drafts so the live <svg> is unambiguous.
live = re.sub(r"<!--.*?-->", "", src, flags=re.S)
match = re.search(r"<svg\b.*?</svg>", live, re.S)
if not match:
    sys.exit("No live <svg> element found in the favicon")
svg = match.group(0).strip().replace('width="32" height="32"', 'width="1024" height="1024"')
header = (
    "<!-- Generated from public/favicon.svg (same artwork, scaled).\n"
    "     Do not edit by hand — run scripts/build-icon.sh instead. -->\n"
)
dst.write_text(header + svg + "\n")
PY

if [[ ! -x "$CHROME" ]]; then
  echo "Chrome not found at $CHROME; set CHROME=/path/to/chrome" >&2
  exit 1
fi

echo "==> Rendering 1024x1024 PNG"
PROFILE="$(mktemp -d)"
rm -f /tmp/yame-icon-raw.png
( "$CHROME" --headless --disable-gpu --no-sandbox --hide-scrollbars \
    --default-background-color=00000000 --window-size=1024,1024 \
    --user-data-dir="$PROFILE" --screenshot=/tmp/yame-icon-raw.png "file://$SVG" \
    >/dev/null 2>&1 & )
# Chrome's headless screenshot does not always exit on its own.
for _ in $(seq 1 30); do
  [[ -f /tmp/yame-icon-raw.png ]] && break
  sleep 1
done
pkill -f "$PROFILE" 2>/dev/null || true
sleep 1
# Chrome can still be flushing its profile when we clean up.
rm -rf "$PROFILE" 2>/dev/null || true

[[ -f /tmp/yame-icon-raw.png ]] || { echo "Chrome produced no screenshot" >&2; exit 1; }

python3 - "/tmp/yame-icon-raw.png" "$PNG" <<'PY'
import sys
from PIL import Image
Image.open(sys.argv[1]).convert("RGBA").resize((1024, 1024), Image.LANCZOS).save(sys.argv[2])
PY

echo "==> Generating the platform icon set"
cd "$ROOT"
npx tauri icon src-tauri/app-icon.png
# Desktop only; the mobile variants are dead weight here.
rm -rf src-tauri/icons/android src-tauri/icons/ios

echo "==> Done: src-tauri/icons"
