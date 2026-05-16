#!/usr/bin/env bash
# Download static ffmpeg binaries from evermeet.cx and place them at the
# locations Tauri's `externalBin` expects:
#   src-tauri/binaries/ffmpeg-aarch64-apple-darwin
#   src-tauri/binaries/ffmpeg-x86_64-apple-darwin
# Then lipo them into the universal binary the universal-apple-darwin
# bundle target requires:
#   src-tauri/binaries/ffmpeg-universal-apple-darwin
#
# Idempotent: skips download if a working binary already exists.

set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
out_dir="$repo_root/src-tauri/binaries"
mkdir -p "$out_dir"

fetch() {
  local triple="$1" url="$2"
  local dest="$out_dir/ffmpeg-$triple"

  if [ -x "$dest" ] && "$dest" -version >/dev/null 2>&1; then
    echo "ffmpeg-$triple already present, skipping"
    return
  fi

  echo "Fetching ffmpeg for $triple..."
  local tmp
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' RETURN

  curl -fsSL "$url" -o "$tmp/ffmpeg.zip"
  unzip -q "$tmp/ffmpeg.zip" -d "$tmp"
  mv "$tmp/ffmpeg" "$dest"
  chmod +x "$dest"

  # Ad-hoc sign so Gatekeeper accepts the unsigned static binary.
  codesign --force --sign - "$dest" >/dev/null 2>&1 || true

  echo "Installed $dest"
}

# Static macOS ffmpeg builds with avfoundation + videotoolbox.
# - osxexperts.net publishes arm64 builds.
# - evermeet.cx publishes x86_64 builds.
# If these URLs go stale, override via env vars: FFMPEG_ARM64_URL / FFMPEG_X64_URL.
arm64_url="${FFMPEG_ARM64_URL:-https://www.osxexperts.net/ffmpeg71arm.zip}"
x64_url="${FFMPEG_X64_URL:-https://evermeet.cx/ffmpeg/getrelease/zip}"

fetch "aarch64-apple-darwin" "$arm64_url"
fetch "x86_64-apple-darwin"  "$x64_url"

# Tauri's `externalBin` for --target universal-apple-darwin expects a single
# pre-lipo'd binary; it does not combine arch binaries itself.
universal="$out_dir/ffmpeg-universal-apple-darwin"
if [ -x "$universal" ] && "$universal" -version >/dev/null 2>&1; then
  echo "ffmpeg-universal-apple-darwin already present, skipping"
else
  echo "Creating universal ffmpeg binary..."
  lipo -create \
    "$out_dir/ffmpeg-aarch64-apple-darwin" \
    "$out_dir/ffmpeg-x86_64-apple-darwin" \
    -output "$universal"
  chmod +x "$universal"
  codesign --force --sign - "$universal" >/dev/null 2>&1 || true
  echo "Installed $universal"
fi
