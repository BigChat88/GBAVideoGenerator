import type { Dither } from "./encoder/ffmpeg";
import type { AudioSpv, VblanksPerFrame } from "./encoder/gba";

export type AudioMode = "source" | "none";
export type AudioCodec = "pcm" | "adpcm";

export interface VideoInput {
  path: string;
  name: string; // shown in the ROM's video list (31 ASCII chars)
}

export interface ConvertOptions {
  videos: VideoInput[]; // played in this order; 2+ videos get a list menu
  outputPath: string; // final .gba path chosen by the user
  romTitle: string; // cartridge header title (12 ASCII chars)

  width: number; // one of VIDEO_RESOLUTIONS
  height: number;
  vblanksPerFrame: VblanksPerFrame; // 1 = 60 fps ... 6 = 10 fps
  dither: Dither; // ffmpeg paletteuse dithering
  compress: boolean; // LZ77 per frame (smaller ROM, slower decode on the GBA)

  audioMode: AudioMode; // "none" => silent track (the player still clocks on it)
  audioSpv: AudioSpv; // audio samples per VBlank (sample rate = spv * 59.7275)
  audioCodec: AudioCodec; // 8-bit PCM, or IMA ADPCM (~half the size)

  allowLarge: boolean; // allow 32..64 MiB ROMs (Matrix-mapped, mGBA only)
}

export const DEFAULT_OPTIONS: Omit<ConvertOptions, "videos" | "outputPath" | "romTitle"> = {
  width: 120,
  height: 80,
  vblanksPerFrame: 5,
  dither: "none",
  compress: false,
  audioMode: "source",
  audioSpv: 304,
  audioCodec: "adpcm",
  allowLarge: false,
};

export type Stage = "probe" | "frames" | "audio" | "pack" | "done";

export type ProgressEvent =
  | { kind: "stage"; stage: Stage; label: string }
  | { kind: "progress"; fraction: number } // 0..1 over the whole conversion
  | { kind: "log"; stream: "stdout" | "stderr"; line: string }
  | { kind: "error"; message: string }
  | { kind: "success"; outputPath: string; romSize: number; large: boolean };
