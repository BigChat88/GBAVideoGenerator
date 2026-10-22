import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { adpcmBlockBytes, adpcmEncode } from "./encoder/adpcm";
import { extractPcm, ProbeResult, probeVideo, streamFrames } from "./encoder/ffmpeg";
import {
  audioRateHz,
  MAX_LARGE_ROM_SIZE,
  MAX_ROM_SIZE,
  PALETTE_BYTES,
  VBLANKS_PER_FRAME,
  VIDEO_RESOLUTIONS,
  videoFps,
} from "./encoder/gba";
import { lz77Compress } from "./encoder/lz77";
import { buildRom, FLAG_ADPCM, FLAG_COMPRESSED, MAX_ENTRIES, PlayerAssets, romSize, VideoEntry } from "./encoder/romfs";
import { resolveFfmpeg } from "./tools-path";
import { ConvertOptions, ProgressEvent, VideoInput } from "./types";

type Emit = (event: ProgressEvent) => void;

const MB = 1024 * 1024;

export function romAssetsDir(resourcesRoot: string): string {
  return join(resourcesRoot, "rom-assets");
}

export async function loadPlayerAssets(resourcesRoot: string): Promise<PlayerAssets> {
  const dir = romAssetsDir(resourcesRoot);
  const [player, playerMb, loader] = await Promise.all(
    ["player.gba", "player_mb.gba", "loader.gba"].map((f) => readFile(join(dir, f)))
  );
  return { player, playerMb, loader };
}

function validate(options: ConvertOptions): void {
  if (options.videos.length === 0) throw new Error("Add at least one video.");
  if (options.videos.length > MAX_ENTRIES) throw new Error(`A ROM holds at most ${MAX_ENTRIES} videos.`);
  if (!VIDEO_RESOLUTIONS.some(([w, h]) => w === options.width && h === options.height)) {
    throw new Error(`Unsupported resolution ${options.width}x${options.height}.`);
  }
  if (!VBLANKS_PER_FRAME.includes(options.vblanksPerFrame)) {
    throw new Error(`Unsupported frame rate (${options.vblanksPerFrame} VBlanks per frame).`);
  }
}

function formatTime(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
}

/** Bytes of audio stored per video frame with these options. */
function audioBytesPerFrame(options: ConvertOptions): number {
  const vpf = options.vblanksPerFrame;
  return options.audioCodec === "adpcm" ? vpf * adpcmBlockBytes(options.audioSpv) : vpf * options.audioSpv;
}

function tooBigError(options: ConvertOptions, video: VideoInput, fitsSeconds: number, multiple: boolean): Error {
  const limit = options.allowLarge ? "64 MB a large (mGBA-only) ROM" : "32 MB a GBA cartridge";
  const suggestions = [
    "lower the resolution or frame rate",
    options.compress ? null : "enable compression",
    options.audioCodec === "adpcm" ? null : "use ADPCM audio",
    options.allowLarge ? null : "allow large ROMs (mGBA only)",
    multiple ? "remove videos" : "use a shorter video",
  ].filter(Boolean);
  return new Error(
    `The ROM would exceed the ${limit} can hold: it filled up ${formatTime(fitsSeconds)} into ` +
      `"${video.name}". To make it fit: ${suggestions.join(", ")}.`
  );
}

interface EncodeContext {
  options: ConvertOptions;
  ffmpeg: string;
  assets: PlayerAssets;
  emit: Emit;
  // Running totals over all the videos, for the size limit and progress
  dataSize: number;
  framesDone: number;
  framesExpected: number;
}

async function encodeVideo(ctx: EncodeContext, video: VideoInput, info: ProbeResult): Promise<VideoEntry> {
  const { options, ffmpeg, emit } = ctx;
  const { width, height, vblanksPerFrame: vpf, audioSpv } = options;
  const log = (line: string) => emit({ kind: "log", stream: "stdout", line });
  const fps = videoFps(vpf);
  const perFrameAudio = audioBytesPerFrame(options);
  const limit = options.allowLarge ? MAX_LARGE_ROM_SIZE : MAX_ROM_SIZE;
  const count = options.videos.length;

  // --- frames: [512 B palette][pixels], LZ77 on the pixels if enabled ---
  const frames: Buffer[] = [];
  let tooBig = false;
  await streamFrames({
    ffmpeg,
    inputPath: video.path,
    width,
    height,
    fps,
    dither: options.dither,
    onFrame: async (palette, pixels) => {
      let blob: Buffer;
      if (options.compress) {
        // The palette stays raw so the player can copy it directly and, for
        // full-width frames, decompress the pixels straight into VRAM
        const packed = lz77Compress(pixels);
        blob = Buffer.concat([palette, packed, Buffer.alloc((4 - (packed.length % 4)) % 4)]);
        ctx.dataSize += blob.length + 4; // + its offset table entry
      } else {
        blob = Buffer.concat([palette, pixels]);
        ctx.dataSize += blob.length;
      }
      frames.push(blob);
      ctx.dataSize += perFrameAudio; // this frame's share of the audio track
      ctx.framesDone++;
      if (romSize(ctx.assets, options.allowLarge, count, ctx.dataSize) > limit) tooBig = true;

      if (frames.length % 24 === 0) {
        emit({ kind: "progress", fraction: Math.min(1, ctx.framesDone / ctx.framesExpected) });
        // Let IPC progress messages through between compressed frames
        if (options.compress) await new Promise((resolve) => setImmediate(resolve));
      }
    },
    shouldStop: () => tooBig,
  });
  if (tooBig) throw tooBigError(options, video, frames.length / fps, count > 1);
  if (frames.length === 0) throw new Error(`No video frames could be decoded from "${video.name}".`);
  if (options.compress) {
    ctx.dataSize += 4; // the offset table's final entry (audio start)
    const raw = frames.length * (PALETTE_BYTES + width * height);
    const packed = frames.reduce((n, f) => n + f.length, 0);
    log(`${frames.length} frames, LZ77 ${(raw / MB).toFixed(1)} MB -> ${(packed / MB).toFixed(1)} MB`);
  } else {
    log(`${frames.length} frames`);
  }

  // --- audio: exactly frames * vpf VBlanks of it, the player's clock ---
  const blocks = frames.length * vpf;
  const rate = audioRateHz(audioSpv);
  const useSource = options.audioMode === "source" && info.hasAudio;
  const limitSec = frames.length / fps + 1;
  let audio: Buffer;
  if (options.audioCodec === "adpcm") {
    const pcm16 = useSource ? await extractPcm(ffmpeg, video.path, rate, limitSec, "s16le") : Buffer.alloc(0);
    audio = adpcmEncode(pcm16, audioSpv, blocks);
  } else {
    audio = Buffer.alloc(blocks * audioSpv); // zeros = silence
    if (useSource) {
      const src = await extractPcm(ffmpeg, video.path, rate, limitSec, "s8");
      src.copy(audio, 0, 0, Math.min(src.length, audio.length));
    }
  }
  log(
    useSource
      ? `Audio: ${rate} Hz mono ${options.audioCodec.toUpperCase()}, ${(audio.length / MB).toFixed(2)} MB`
      : options.audioMode === "none"
        ? "Audio disabled; using a silent track."
        : "No audio track found; using a silent track."
  );

  let data: Buffer;
  if (options.compress) {
    // u32 offsets[frames + 1] relative to the data start; the last one
    // points at the audio track
    const table = Buffer.alloc(4 * (frames.length + 1));
    let cur = table.length;
    frames.forEach((blob, i) => {
      table.writeUInt32LE(cur, i * 4);
      cur += blob.length;
    });
    table.writeUInt32LE(cur, frames.length * 4);
    data = Buffer.concat([table, ...frames, audio]);
  } else {
    data = Buffer.concat([...frames, audio]);
  }

  return {
    name: video.name,
    data,
    vblanksPerFrame: vpf,
    frameCount: frames.length,
    width,
    height,
    audioSpv,
    flags: (options.compress ? FLAG_COMPRESSED : 0) | (options.audioCodec === "adpcm" ? FLAG_ADPCM : 0),
  };
}

/**
 * Video files -> .gba: frames are quantized to a per-frame palette by ffmpeg,
 * the first audio track becomes 8-bit PCM or IMA ADPCM locked to the VBlank,
 * and every video is appended to the precompiled player as a VMKFS entry
 * (layout of GbaVideo's tool/converter.py). Over 32 MiB (when allowed) the
 * Matrix-mapped large layout is used instead.
 */
export async function convertToGba(options: ConvertOptions, resourcesRoot: string, emit: Emit): Promise<number> {
  validate(options);
  const ffmpeg = resolveFfmpeg(resourcesRoot);
  const assets = await loadPlayerAssets(resourcesRoot);
  const log = (line: string) => emit({ kind: "log", stream: "stdout", line });
  const fps = videoFps(options.vblanksPerFrame);

  emit({ kind: "stage", stage: "probe", label: "Reading the videos..." });
  const infos: ProbeResult[] = [];
  for (const video of options.videos) {
    if (!existsSync(video.path)) {
      throw new Error(
        `"${video.name}" is no longer at ${video.path} (moved, renamed or deleted after adding it?). ` +
          `Remove it from the list and add it again.`
      );
    }
    const info = await probeVideo(ffmpeg, video.path);
    if (!info.hasVideo) throw new Error(`"${video.name}" has no video stream.`);
    infos.push(info);
  }

  const ctx: EncodeContext = {
    options,
    ffmpeg,
    assets,
    emit,
    dataSize: 0,
    framesDone: 0,
    framesExpected: Math.max(1, infos.reduce((n, i) => n + Math.floor(i.duration * fps), 0)),
  };
  log(
    `${options.videos.length} video(s), ${options.width}x${options.height} @ ${fps.toFixed(2)} fps ` +
      `(~${ctx.framesExpected} frames)`
  );

  const entries: VideoEntry[] = [];
  for (const [i, video] of options.videos.entries()) {
    const n = options.videos.length;
    emit({ kind: "stage", stage: "frames", label: n > 1 ? `Encoding video ${i + 1}/${n}: ${video.name}` : "Encoding frames..." });
    log(`--- ${video.name} (${formatTime(infos[i].duration)})`);
    entries.push(await encodeVideo(ctx, video, infos[i]));
  }
  emit({ kind: "progress", fraction: 1 });

  emit({ kind: "stage", stage: "pack", label: "Building the .gba ROM..." });
  const dataSize = entries.reduce((n, e) => n + e.data.length, 0);
  const large = options.allowLarge && romSize(assets, false, entries.length, dataSize) > MAX_ROM_SIZE;
  const rom = buildRom(assets, entries, options.romTitle, large);
  if (rom.length > (large ? MAX_LARGE_ROM_SIZE : MAX_ROM_SIZE)) {
    // The running estimate already stops long before this; just in case
    throw new Error(`The ROM came out at ${(rom.length / MB).toFixed(1)} MB, over the limit.`);
  }
  if (large) log("Over 32 MB: built as a large Matrix-mapped ROM (plays in mGBA only).");

  await mkdir(dirname(options.outputPath), { recursive: true });
  const tmp = `${options.outputPath}.tmp`;
  await writeFile(tmp, rom);
  await moveFile(tmp, options.outputPath);
  log(`ROM size ${(rom.length / MB).toFixed(2)} MB`);

  emit({ kind: "stage", stage: "done", label: "Done" });
  emit({ kind: "success", outputPath: options.outputPath, romSize: rom.length, large });
  return rom.length;
}

async function moveFile(src: string, dest: string): Promise<void> {
  try {
    await rm(dest, { force: true });
    await rename(src, dest);
  } catch {
    await copyFile(src, dest);
    await rm(src, { force: true });
  }
}
