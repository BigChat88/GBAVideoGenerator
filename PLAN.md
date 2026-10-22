# GBA Video Generator — plan

Turn a video file into a single playable `.gba` ROM, like
[N64VideoGenerator](../N64VideoGenerator) does for the N64, reusing the GBA
engine from [GbaVideo](../GbaVideo) (Bytecodes Software, modified version).

Unlike the N64 project, no native per-platform tools are needed: the GBA video
format (8bpp frames with a per-frame palette + signed 8-bit PCM) is simple
enough to encode in TypeScript, so the app only depends on `ffmpeg`/`ffprobe`
plus one precompiled player ROM.

## Layout

```
core/                 GBA player (C, devkitARM + libtonc)
app/                  Electron app (TypeScript)
  src/main/encoder/   frames, audio, LZ77, VMKFS, GBA header
  resources/rom-assets/player.gba   precompiled player (see MANIFEST.md)
```

## Phase 1 — video-only GBA player (`core/`)

- [x] Take `GbaVideo/gba/source`, drop menu/browser/image/audio players and
      the Matrix 64 MiB variant.
- [x] Boot straight into `player_video_run(0)`; "NO VIDEO" screen otherwise.
- [x] Controls: START/SELECT pause, LEFT/RIGHT seek ±5 s (time bar),
      B restarts. No UP/DOWN track switching.
- [x] End of video: hold the last frame (loop flag later dropped, see Phase 5).
- [x] Keep VMKFS v1 unchanged (one video entry, empty thumbnail).
- [x] Build with Docker (`devkitpro/devkitarm`) and commit
      `app/resources/rom-assets/player.gba` + `MANIFEST.md`.

## Phase 2 — TypeScript encoder (`app/src/main/encoder/`)

- [x] `ffprobe`: duration, audio streams (first audio track is used).
- [x] Frames: ffmpeg scale + letterbox + `fps=59.7275/vpf` + per-frame
      palette (`palettegen=stats_mode=single:max_colors=252` /
      `paletteuse=new=1`), `rawvideo pal8` piped to Node; ARGB palette →
      RGB555 (512 B). Indices 252–255 reserved for the seek bar overlay.
      Fallback if pal8 output lacks the palette: median-cut in TS.
- [x] Audio: ffmpeg → s8 mono at `spv * 59.7275` Hz, trimmed/padded to
      `frames * vpf * spv` samples; zeros when silent.
- [x] Optional LZ77 (BIOS type 0x10, VRAM-safe min_disp=2), hash chains,
      yields between frames (no worker thread needed so far). Layout `offsets[n+1] | frames | pcm`.
- [x] Pack: `player.gba` + 0xFF pad to 256 B + VMKFS.
- [x] GBA header: title (12 chars), game code, complement checksum.
- [x] Size estimate + 32 MB warning.

## Phase 3 — UI

- [x] Input video, ROM title, resolution (96×64…240×160), fps (10…60), live
  ROM size estimate.
- [x] Advanced: audio rate (9.1–36.3 kHz) / no audio, LZ77, dithering,
  end-of-video behavior (later removed).
- [x] "Convert to .gba", optional "Test in mGBA".

## Phase 4 — tests & packaging

- [x] `smoke-test.mjs`: header checksum, VMKFS magic/offsets, audio length.
- [x] Structural parity with `GbaVideo/tool/converter.py` (same frame count,
      data size, entry params; PCM byte-identical; LZ77 within 0.4%).
- [x] Manual mGBA test (A/V sync, pause, seek, end hold, real 4-min video).
- [x] electron-builder: Windows portable built locally; Linux AppImage and
      macOS zip (arm64) via `.github/workflows/release.yml`.

## Phase 5 — playlists, ADPCM, large ROMs, bundled ffmpeg

- [x] Several videos per ROM: list menu (Mode 3), L/R previous/next, B back
      to the list, auto-advance; a single video still boots straight in.
- [x] No loop option: at the end the last frame stays with a play icon,
      START/A plays again (as in N64VideoGenerator).
- [x] IMA ADPCM audio inside videos (`VMK_FLAG_ADPCM`), ~half the size.
- [x] 32..64 MiB ROMs via the Matrix mapper (mGBA only): `core/loader`,
      multiboot `player_mb.gba`, `romio.h` reads through the 4 KiB window.
- [x] ffmpeg bundled (BtbN LGPL builds for Windows/Linux, built from source
      on macOS) and ffprobe dropped: nothing to install for end users.
- [x] Release workflow: player build, smoke test, 3 platforms, GitHub
      Release.
- [ ] Test on real hardware (flashcart).
