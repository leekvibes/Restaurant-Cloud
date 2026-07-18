#!/bin/sh
# Build every PWA icon from one square source image.
#
#   ./scripts/make-icons.sh [path-to-logo.png]     (default: brand/logo-source.png)
#
# Uses macOS `sips`, so there's nothing to install. Icons are committed, so
# this only ever runs on a Mac when the logo changes — never during a deploy.
set -e

SRC="${1:-brand/logo-source.png}"
OUT=public
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

if [ ! -f "$SRC" ]; then
  echo "No logo at '$SRC'."
  echo "Save the square logo there (or pass a path) and run this again."
  exit 1
fi

W=$(sips -g pixelWidth "$SRC" | awk '/pixelWidth/{print $2}')
H=$(sips -g pixelHeight "$SRC" | awk '/pixelHeight/{print $2}')
echo "Source: $SRC (${W}x${H})"
[ "$W" = "$H" ] || echo "  note: not square — it will be padded to square, which may look off-centre."

# Full-bleed icons. Declared purpose "any", so nothing gets cropped.
sips -s format png -z 192 192 "$SRC" --out "$OUT/icon-192.png" >/dev/null
sips -s format png -z 512 512 "$SRC" --out "$OUT/icon-512.png" >/dev/null

# Flatten transparency onto white. A round logo leaves transparent corners, and
# iOS composites those onto BLACK — you get a dark square with a circle in it.
# Round-tripping through JPEG is how sips flattens without extra tooling.
flatten() { # flatten <in.png> <out.png>
  sips -s format jpeg -s formatOptions best "$1" --out "$TMP/flat.jpg" >/dev/null
  sips -s format png "$TMP/flat.jpg" --out "$2" >/dev/null
}

# Maskable: Android crops to a circle/squircle and only guarantees the middle
# ~80%. Shrink to 78% on white so the outer lettering survives the crop.
sips -s format png -z 400 400 "$SRC" --out "$TMP/m.png" >/dev/null
sips -p 512 512 --padColor FFFFFF "$TMP/m.png" --out "$TMP/m2.png" >/dev/null
flatten "$TMP/m2.png" "$OUT/icon-maskable-512.png"

# iOS rounds the corners itself, so pad slightly and flatten.
sips -s format png -z 162 162 "$SRC" --out "$TMP/a.png" >/dev/null
sips -p 180 180 --padColor FFFFFF "$TMP/a.png" --out "$TMP/a2.png" >/dev/null
flatten "$TMP/a2.png" "$OUT/apple-touch-icon.png"

# Small mark for the sidebar and top bar (rendered at 22-28px, so 64 is plenty).
sips -s format png -z 64 64 "$SRC" --out "$OUT/logo.png" >/dev/null

echo "Wrote:"
for f in icon-192 icon-512 icon-maskable-512 apple-touch-icon logo; do
  printf '  %-22s %s bytes\n' "$f.png" "$(wc -c < "$OUT/$f.png" | tr -d ' ')"
done
echo "Commit these, redeploy, then remove and re-add the home screen bookmark."
