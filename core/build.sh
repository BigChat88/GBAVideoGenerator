#!/bin/sh
# Builds the GBA player inside the devkitARM Docker image and installs it to
# app/resources/rom-assets/player.gba. Usage: ./build.sh [make targets...]
set -e
[ $# -eq 0 ] && set -- install
cd "$(dirname "$0")/.."
# MSYS_NO_PATHCONV: keep Git Bash on Windows from rewriting the container paths
MSYS_NO_PATHCONV=1 docker run --rm -v "$(pwd -W 2>/dev/null || pwd):/src" -w /src/core \
  devkitpro/devkitarm:latest make "$@"
