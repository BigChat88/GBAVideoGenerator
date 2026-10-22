import { spawn } from "node:child_process";
import { PALETTE_BYTES, VIDEO_COLORS } from "./gba";

export interface ProbeResult {
  duration: number; // seconds, 0 if unknown
  hasVideo: boolean;
  hasAudio: boolean;
}

/**
 * Duration and stream types from `ffmpeg -i`'s input summary, so only the
 * ffmpeg binary has to be bundled (no ffprobe). Without an output ffmpeg
 * exits with an error after printing it, which is expected here.
 */
export async function probeVideo(ffmpeg: string, inputPath: string): Promise<ProbeResult> {
  const child = spawn(ffmpeg, ["-hide_banner", "-nostdin", "-i", inputPath]);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`Could not run ffmpeg ("${ffmpeg}"): ${err.message}`)));
    child.on("close", () => resolve());
  });

  if (!/^Input #0/m.test(stderr)) {
    const reason = stderr.trim().split(/\r?\n/).pop() ?? "";
    throw new Error(`ffmpeg could not read "${inputPath}"${reason ? `: ${reason}` : ""}`);
  }
  const d = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  // Cover art in audio files shows up as an "(attached pic)" video stream
  const streams = stderr.split(/\r?\n/).filter((l) => /^\s*Stream #0:/.test(l));
  return {
    duration: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0,
    hasVideo: streams.some((l) => /: Video:/.test(l) && !/\(attached pic\)/.test(l)),
    hasAudio: streams.some((l) => /: Audio:/.test(l)),
  };
}

export type Dither = "none" | "bayer" | "sierra2_4a" | "floyd_steinberg";

export interface FrameStreamOptions {
  ffmpeg: string;
  inputPath: string;
  width: number;
  height: number;
  fps: number;
  dither: Dither;
  /** One call per frame: RGB555 palette (512 B) + width*height palette indices. */
  onFrame: (palette: Buffer, pixels: Buffer) => void | Promise<void>;
  /** Return true to stop decoding early (e.g. the ROM got too big). */
  shouldStop?: () => boolean;
}

/**
 * Decodes the video as letterboxed WxH frames at `fps`, each quantized to its
 * own 252-color palette by ffmpeg (palettegen stats_mode=single + paletteuse
 * new=1). rawvideo pal8 carries every frame as W*H indices followed by the
 * 256-entry palette as native-endian 0xAARRGGBB words.
 */
export async function streamFrames(opts: FrameStreamOptions): Promise<void> {
  const { width: w, height: h } = opts;
  const dither = opts.dither === "bayer" ? "bayer:bayer_scale=3" : opts.dither;
  const vf =
    `fps=${opts.fps.toFixed(5)},` +
    `scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos,` +
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:black,` +
    `split[a][b];[a]palettegen=stats_mode=single:max_colors=${VIDEO_COLORS}:reserve_transparent=0[p];` +
    `[b][p]paletteuse=new=1:dither=${dither}`;

  const child = spawn(opts.ffmpeg, [
    "-v", "error", "-nostdin", "-i", opts.inputPath,
    "-map", "0:v:0", "-vf", vf, "-f", "rawvideo", "-pix_fmt", "pal8", "-",
  ]);
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`Could not run ffmpeg ("${opts.ffmpeg}"): ${err.message}`)));
    child.on("close", resolve);
  });

  const pixelBytes = w * h;
  const frameBytes = pixelBytes + 1024;
  let pending: Buffer = Buffer.alloc(0);
  let stopped = false;
  try {
    for await (const chunk of child.stdout as AsyncIterable<Buffer>) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let off = 0;
      while (pending.length - off >= frameBytes) {
        const pixels = Buffer.from(pending.subarray(off, off + pixelBytes));
        const palette = toRgb555(pending.subarray(off + pixelBytes, off + frameBytes));
        off += frameBytes;
        await opts.onFrame(palette, pixels);
        if (opts.shouldStop?.()) {
          stopped = true;
          break;
        }
      }
      pending = pending.subarray(off);
      if (stopped) break;
    }
  } finally {
    if (stopped || child.exitCode === null) child.kill();
  }

  const code = await exited;
  if (!stopped && code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(`ffmpeg failed decoding the video (exit code ${code})${tail ? `: ${tail}` : ""}`);
  }
}

function toRgb555(argb: Buffer): Buffer {
  const out = Buffer.alloc(PALETTE_BYTES);
  for (let c = 0; c < 256; c++) {
    const v = argb.readUInt32LE(c * 4); // every supported host is little-endian
    const r = (v >> 16) & 0xff;
    const g = (v >> 8) & 0xff;
    const b = v & 0xff;
    out.writeUInt16LE((r >> 3) | ((g >> 3) << 5) | ((b >> 3) << 10), c * 2);
  }
  return out;
}

/**
 * First audio track as mono PCM at `rateHz`: signed 8-bit (what the GBA
 * plays) or s16le (input of the ADPCM encoder).
 */
export async function extractPcm(
  ffmpeg: string,
  inputPath: string,
  rateHz: number,
  durationLimit: number,
  format: "s8" | "s16le"
): Promise<Buffer> {
  const child = spawn(ffmpeg, [
    "-v", "error", "-nostdin", "-i", inputPath, "-t", durationLimit.toFixed(3),
    "-map", "0:a:0", "-vn", "-ac", "1", "-ar", String(rateHz),
    "-acodec", format === "s8" ? "pcm_s8" : "pcm_s16le", "-f", format, "-",
  ]);
  const chunks: Buffer[] = [];
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString("utf8")).slice(-4000)));
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on("error", (err) => reject(new Error(`Could not run ffmpeg ("${ffmpeg}"): ${err.message}`)));
    child.on("close", resolve);
  });
  if (code !== 0) {
    const tail = stderr.trim().split(/\r?\n/).slice(-3).join(" ");
    throw new Error(`ffmpeg failed extracting the audio (exit code ${code})${tail ? `: ${tail}` : ""}`);
  }
  return Buffer.concat(chunks);
}
