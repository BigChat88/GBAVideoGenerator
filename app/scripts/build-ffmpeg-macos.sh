#!/bin/sh
# Builds a static LGPL ffmpeg for macOS (the host's architecture) into
# resources/tools/darwin-<arch>/bin/ffmpeg. There is no LGPL macOS download
# like BtbN's for Windows/Linux, so the release workflow runs this on its
# macOS runner. Only native decoders + dav1d (AV1) are enabled: no GPL parts
# and no other external libraries, so the binary only links system
# frameworks. Needs: Xcode command line tools, meson, ninja, nasm, pkg-config.
set -eu

FFMPEG_VERSION=8.1
DAV1D_VERSION=1.5.1

APP_ROOT=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) ARCH=arm64 ;;
  x86_64) ARCH=x64 ;;
  *) echo "unsupported architecture $(uname -m)" >&2; exit 1 ;;
esac
OUT="$APP_ROOT/resources/tools/darwin-$ARCH"
WORK=$(mktemp -d)
PREFIX="$WORK/prefix"
trap 'rm -rf "$WORK"' EXIT
JOBS=$(sysctl -n hw.ncpu)

cd "$WORK"
curl -fsSL "https://code.videolan.org/videolan/dav1d/-/archive/$DAV1D_VERSION/dav1d-$DAV1D_VERSION.tar.gz" | tar xz
meson setup dav1d-build "dav1d-$DAV1D_VERSION" --prefix="$PREFIX" --libdir=lib \
  --buildtype=release --default-library=static -Denable_tools=false -Denable_tests=false
ninja -C dav1d-build install

curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" | tar xJ
cd "ffmpeg-$FFMPEG_VERSION"
PKG_CONFIG_PATH="$PREFIX/lib/pkgconfig" ./configure \
  --prefix="$PREFIX" --pkg-config-flags=--static \
  --enable-static --disable-shared \
  --disable-doc --disable-ffplay --disable-ffprobe --disable-network \
  --disable-autodetect --enable-libdav1d --enable-zlib \
  --enable-videotoolbox --enable-audiotoolbox \
  --extra-version=gbavideogenerator
make -j"$JOBS"

mkdir -p "$OUT/bin"
cp ffmpeg "$OUT/bin/ffmpeg"
cp COPYING.LGPLv2.1 "$OUT/FFMPEG-LICENSE.txt"
cat > "$OUT/FFMPEG-SOURCE.txt" <<EOF
bin/ffmpeg is an unmodified LGPL build of FFmpeg $FFMPEG_VERSION (https://ffmpeg.org)
with dav1d $DAV1D_VERSION, built by app/scripts/build-ffmpeg-macos.sh.
Source code: https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz and
https://code.videolan.org/videolan/dav1d. License: FFMPEG-LICENSE.txt.
EOF
"$OUT/bin/ffmpeg" -hide_banner -version
