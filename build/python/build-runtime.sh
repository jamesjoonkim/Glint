#!/usr/bin/env bash
# Build the bundled MLX runtime as a signed standalone binary.
#
# Output: resources/runtime/glint-mlx-server (arm64, signed, ready for
# notarization with the rest of the app).
#
# Run from repo root:
#   bash build/python/build-runtime.sh
#
# Required env (signing only):
#   APPLE_DEV_ID_APPLICATION  — "Developer ID Application: Your Name (TEAMID)"

set -euo pipefail

cd "$(dirname "$0")/../.."

ROOT="$(pwd)"
BUILD_DIR="$ROOT/build/python"
OUT_DIR="$ROOT/resources/runtime"
VENV="$BUILD_DIR/.venv"

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "error: must build on Apple Silicon (uname -m = $(uname -m))" >&2
  exit 1
fi

if ! command -v python3.11 >/dev/null 2>&1; then
  echo "error: python3.11 not found. Install via 'brew install python@3.11'" >&2
  exit 1
fi

echo "==> creating venv ..."
python3.11 -m venv "$VENV"

echo "==> installing python deps ..."
"$VENV/bin/pip" install --upgrade pip wheel
"$VENV/bin/pip" install -r "$BUILD_DIR/requirements.txt"
"$VENV/bin/pip" install pyinstaller

echo "==> running pyinstaller ..."
cd "$BUILD_DIR"
"$VENV/bin/pyinstaller" --noconfirm --clean runtime.spec
cd "$ROOT"

mkdir -p "$OUT_DIR"
mv "$BUILD_DIR/dist/glint-mlx-server" "$OUT_DIR/glint-mlx-server"
chmod +x "$OUT_DIR/glint-mlx-server"

if [[ -n "${APPLE_DEV_ID_APPLICATION:-}" ]]; then
  echo "==> codesigning ..."
  codesign --deep --force --options runtime \
    --sign "$APPLE_DEV_ID_APPLICATION" \
    "$OUT_DIR/glint-mlx-server"
  codesign --verify --deep --strict --verbose=2 "$OUT_DIR/glint-mlx-server"
else
  echo "warn: APPLE_DEV_ID_APPLICATION not set — binary unsigned (Gatekeeper will block)" >&2
fi

echo "==> done: $OUT_DIR/glint-mlx-server ($(du -h "$OUT_DIR/glint-mlx-server" | cut -f1))"
