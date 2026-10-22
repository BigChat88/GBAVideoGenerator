// GBA timing and format constants. Must match core/source (vmkfs.h,
// player_video.c): every rate is locked to the 59.7275 Hz refresh, which is
// what keeps the player's audio and video in sync.

export const VBLANK_HZ = 59.7275;

// Audio rates as samples per VBlank (must divide the 280896 cycles of a frame
// and be 4-aligned, see vmkfs.h); hz is the resulting ffmpeg sample rate.
export const AUDIO_RATES = [
  { spv: 152, hz: 9078 },
  { spv: 228, hz: 13618 },
  { spv: 304, hz: 18157 },
  { spv: 456, hz: 27235 },
  { spv: 608, hz: 36314 },
] as const;
export type AudioSpv = (typeof AUDIO_RATES)[number]["spv"];
export const DEFAULT_AUDIO_SPV: AudioSpv = 304;

// Frame rates as VBlanks per frame (60, 30, 20, 15, 12, 10 fps)
export const VBLANKS_PER_FRAME = [1, 2, 3, 4, 5, 6] as const;
export type VblanksPerFrame = (typeof VBLANKS_PER_FRAME)[number];

// 3:2 resolutions; widths a multiple of 4 (the player copies rows with 32-bit
// writes) and scaled up to 240x160 by the BG2 affine matrix.
export const VIDEO_RESOLUTIONS = [
  [96, 64],
  [120, 80],
  [144, 96],
  [168, 112],
  [192, 128],
  [216, 144],
  [240, 160],
] as const;

export const PALETTE_BYTES = 512;
// Palette indices 252..255 are reserved for the player's seek bar overlay
export const VIDEO_COLORS = 252;

// Standard cartridge address space: anything past this is not reachable on
// real hardware (the 0x0A/0x0C regions are mirrors of the same 32 MiB).
export const MAX_ROM_SIZE = 32 * 1024 * 1024;
// Large ROMs (Matrix-mapped, mGBA only): the mapper addresses 64 MiB
export const MAX_LARGE_ROM_SIZE = 64 * 1024 * 1024;

export function audioRateHz(spv: number): number {
  return AUDIO_RATES.find((r) => r.spv === spv)?.hz ?? Math.round(spv * VBLANK_HZ);
}

export function videoFps(vpf: number): number {
  return VBLANK_HZ / vpf;
}
