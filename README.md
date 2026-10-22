# GBA Video Generator

## What it does

Turns ordinary video files into a **playable Game Boy Advance ROM** that
plays them back with sound on a GBA flashcart or in any GBA emulator (tested
in mGBA).

A small, generic player program ([core/](core/)) is compiled once for the
GBA; each conversion only re-encodes your videos into the GBA's native
formats and appends them to a copy of that player.

## What it generates

A single **`.gba` ROM file** at the location you choose. It embeds the
videos, their audio and the player, and needs nothing else to run.

- **One or more videos:** a single video starts playing right away; with
  several, the ROM opens on a list menu and plays them in order.
- **Video:** 96×64 up to 240×160 (hardware-upscaled to the full 240×160
  screen), 10 to 60 fps. Every frame gets its own 252-color palette;
  optional dithering and experimental LZ77 compression.
- **Audio:** mono, 9.1 to 36.3 kHz, as 8-bit PCM or IMA ADPCM (about half
  the size), locked to the GBA's 59.73 Hz refresh so audio and video never
  drift.
- **Size:** up to **32 MB**, the most a GBA cartridge can address. Optionally
  up to **64 MB** as a "large ROM" using the GBA Video cartridge mapper —
  those only play in **mGBA** (not on flashcarts or other emulators). The app
  shows a size estimate before converting.

### Controls on the GBA

| Button | Action |
|---|---|
| START / A / SELECT | Pause / resume |
| Left / Right | Seek −5 s / +5 s (hold to repeat) |
| B | Restart the video (single video) / back to the list (several videos) |
| L / R | Previous / next video (several videos) |
| Up / Down, A | Pick a video in the list menu |

When a video ends it stays on its last frame with a **play icon**; press
START or A to play it again. With several videos each one moves on to the
next, and the icon appears after the last one (START/A replays the list,
B returns to the menu).

## Desktop application

### How to run it

Download the build for your OS from the project's GitHub Releases and run it
directly — **nothing to install** (ffmpeg is included):

- **Windows (10/11, 64-bit):** `GBAVideoGenerator-<version>-portable.exe`.
- **Linux (x86_64):** `GBAVideoGenerator-<version>-linux-x86_64.AppImage` —
  `chmod +x` it and run it.
- **macOS (Apple Silicon):** `GBAVideoGenerator-<version>-mac-arm64.zip` —
  unzip and run the `.app`. It isn't code-signed, so the first launch needs
  *right-click → Open*.

Then: **Add videos...** (reorder or rename them in the list) → set a ROM
title → choose resolution and frame rate (watch the size estimate) →
**Convert to .gba** → choose where to save it → optionally **Test in mGBA**
(found on `PATH`, in the default install folder, or picked once and
remembered).

### Development

```bash
cd app
npm install
npm run fetch-ffmpeg # downloads the LGPL ffmpeg build into resources/tools/
npm start            # builds and opens the app
npm run smoke-test   # runs the pipeline without UI and checks the ROMs
npm run dist         # portable .exe / AppImage under app/release
```

Without `fetch-ffmpeg`, a development checkout falls back to an `ffmpeg` on
your `PATH`. On macOS, `scripts/build-ffmpeg-macos.sh` builds it from source
instead (needs meson, ninja, nasm, pkg-config).

The player is prebuilt in `app/resources/rom-assets/`. After changing
`core/`, rebuild it with `core/build.sh` (needs Docker; uses the
`devkitpro/devkitarm` image) — see
[MANIFEST.md](app/resources/rom-assets/MANIFEST.md).

Pushing to `main` runs [.github/workflows/release.yml](.github/workflows/release.yml):
it compiles the player, runs the smoke test, builds all three platforms with
ffmpeg bundled and publishes a GitHub Release.

## Project layout

```
core/source/          GBA player (C, devkitARM + libtonc)
core/loader/          boot loader for large (>32 MB) ROMs
core/build.sh         builds the player in Docker
app/src/main/         Electron main process + conversion pipeline
app/src/main/encoder/ ffmpeg frames/audio, LZ77, ADPCM, VMKFS packing, header
app/src/renderer/     UI (plain html/css/js)
app/resources/        prebuilt player (rom-assets/), bundled ffmpeg (tools/)
app/assets/           app icon (icon-original.png is the unedited source)
```

## Credits / license

The bundled ffmpeg is an unmodified LGPL build of [FFmpeg](https://ffmpeg.org)
(Windows/Linux from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds),
macOS built by `app/scripts/build-ffmpeg-macos.sh`); its license and source
pointers ship next to it in `resources/tools/<platform>/`.

Built with [libtonc](https://github.com/devkitPro/libtonc),
[devkitARM](https://devkitpro.org), [FFmpeg](https://ffmpeg.org) and
[Electron](https://www.electronjs.org).

This project is not affiliated with Nintendo. Game Boy Advance is a trademark
of Nintendo.

## AI Note

The application was developed using AI. I'm just an enthusiast who wanted to create interesting projects. In this case, how it was achieved is not relevant to me.
