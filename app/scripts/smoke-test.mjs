// Runs the conversion pipeline without the UI on generated test clips and
// checks the ROMs byte by byte against what core/source expects.
//   npm run smoke-test [-- path/to/video.mp4]
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = dirname(here);
const dist = (p) => pathToFileURL(join(appRoot, "dist", "main", p));
const { convertToGba } = await import(dist("convert.js"));
const { lz77Compress, lz77Decompress } = await import(dist("encoder/lz77.js"));
const { adpcmEncode, adpcmDecodeBlock } = await import(dist("encoder/adpcm.js"));
const { resolveFfmpeg } = await import(dist("tools-path.js"));

const resourcesRoot = join(appRoot, "resources");
const ffmpeg = resolveFfmpeg(resourcesRoot);
const tempDir = await mkdtemp(join(tmpdir(), "gbavideogen-smoke-"));
const MB = 1024 * 1024;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeClip(path, seconds, tone) {
  execFileSync(ffmpeg, [
    "-v", "error", "-y",
    "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=30",
    "-f", "lavfi", "-i", `sine=frequency=${tone}:sample_rate=44100`,
    "-t", String(seconds), "-shortest", path,
  ]);
}

function checkLz77() {
  const samples = [
    Buffer.alloc(0),
    Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab"),
    Buffer.from(Array.from({ length: 38400 }, (_, i) => (i * 7 + (i >> 5)) & 0xff)),
    Buffer.from(Array.from({ length: 9600 }, () => Math.floor(Math.random() * 252))),
    Buffer.from(Array.from({ length: 9600 }, (_, i) => Math.floor(i / 40) % 3)),
  ];
  for (const s of samples) {
    const packed = lz77Compress(s);
    const back = lz77Decompress(packed);
    assert(back.equals(s), `LZ77 round trip failed (${s.length} bytes)`);
    // VRAM-safe: no match may reference the byte right before it
    for (let i = 4; i < packed.length; ) {
      const flag = packed[i++];
      for (let bit = 0; bit < 8 && i < packed.length; bit++) {
        if (flag & (0x80 >> bit)) {
          const disp = ((packed[i] & 0x0f) << 8) | packed[i + 1];
          assert(disp >= 1, "LZ77 match with distance 1 (unsafe for VRAM)");
          i += 2;
        } else i++;
      }
    }
  }
  console.log("[smoke-test] LZ77 round trip OK");
}

function checkAdpcm() {
  const spv = 304;
  const blocks = 20;
  const pcm = Buffer.alloc(blocks * spv * 2);
  for (let i = 0; i < blocks * spv; i++) pcm.writeInt16LE(Math.round(12000 * Math.sin(i / 7)), i * 2);
  const enc = adpcmEncode(pcm, spv, blocks);
  assert(enc.length === blocks * (4 + spv / 2), "ADPCM size");
  let err = 0;
  // Block 0 is skipped: the step size starts at its minimum and needs a few
  // samples to adapt to a loud start (same as GbaVideo's encoder)
  for (let b = 1; b < blocks; b++) {
    const dec = adpcmDecodeBlock(enc.subarray(b * (4 + spv / 2)), spv);
    for (let i = 0; i < spv; i++) err = Math.max(err, Math.abs(dec[i] - (pcm.readInt16LE((b * spv + i) * 2) >> 8)));
  }
  assert(err <= 8, `ADPCM error too high (${err})`);
  console.log(`[smoke-test] ADPCM round trip OK (max error ${err}/128)`);
}

function checkRom(rom, opts) {
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum += rom[i];
  assert(rom[0xbd] === ((-(sum + 0x19)) & 0xff), "bad header complement checksum");
  assert(rom.subarray(0xa0, 0xac).toString("latin1").startsWith("SMOKE TEST"), "header title not written");

  const fsOff = rom.indexOf(Buffer.from("VMKFS01\0", "latin1"));
  const large = rom.length > 32 * MB;
  if (large) {
    // Matrix layout: mGBA needs a game code starting with "M"; FS at 0x42000
    assert(rom[0xac] === 0x4d, "large ROM game code must start with M");
    assert(fsOff === 0x42000, `large ROM filesystem at 0x${fsOff.toString(16)}, expected 0x42000`);
  } else {
    assert(fsOff > 0 && fsOff % 256 === 0, `VMKFS not on a 256-byte boundary (${fsOff})`);
  }
  const fs = rom.subarray(fsOff);
  const count = fs.readUInt32LE(12);
  assert(fs.readUInt32LE(8) === 1 && count === opts.videos.length, "VMKFS version/count");

  let frames = 0;
  for (let k = 0; k < count; k++) {
    const e = 16 + k * 64;
    assert(fs.readUInt32LE(e) === 2, "entry type is not video");
    const name = fs.subarray(e + 4, e + 36).toString("latin1").replace(/\0.*$/s, "");
    assert(name === opts.videos[k].name, `entry ${k} name is "${name}"`);
    const offset = fs.readUInt32LE(e + 36);
    const size = fs.readUInt32LE(e + 40);
    const vpf = fs.readUInt32LE(e + 44);
    const nframes = fs.readUInt32LE(e + 48);
    const res1 = fs.readUInt32LE(e + 56);
    const res2 = fs.readUInt32LE(e + 60);
    const [w, h] = [res1 >>> 16, res1 & 0xffff];
    const spv = res2 >>> 16;
    const adpcm = opts.audioCodec === "adpcm";
    assert(offset % 4 === 0, "data offset not 4-aligned");
    assert(w === opts.width && h === opts.height && vpf === opts.vblanksPerFrame && spv === opts.audioSpv, "entry params");
    assert(!!(res2 & 1) === opts.compress && !!(res2 & 4) === adpcm && !(res2 & 2), "entry flags");
    assert(nframes > 0, "no frames");

    const data = fs.subarray(offset, offset + size);
    const audioBytes = nframes * vpf * (adpcm ? 4 + spv / 2 : spv);
    if (opts.compress) {
      const offs = Array.from({ length: nframes + 1 }, (_, i) => data.readUInt32LE(i * 4));
      for (let i = 0; i < nframes; i++) {
        assert(offs[i] % 4 === 0, `frame ${i} not 4-aligned`);
        const pix = lz77Decompress(data.subarray(offs[i] + 512, offs[i + 1]));
        assert(pix.length === w * h, `frame ${i} decompresses to ${pix.length} bytes`);
        assert(pix.every((v) => v < 252), `frame ${i} uses reserved palette indices`);
      }
      assert(size - offs[nframes] === audioBytes, "audio length (compressed)");
    } else {
      assert(size === nframes * (512 + w * h) + audioBytes, "data size (raw)");
      const pix = data.subarray(512, 512 + w * h);
      assert(pix.every((v) => v < 252), "frame 0 uses reserved palette indices");
    }
    frames += nframes;
  }
  return { frames, size: rom.length, large };
}

try {
  checkLz77();
  checkAdpcm();

  let inputPath = process.argv[2];
  if (!inputPath) {
    inputPath = join(tempDir, "clip.mp4");
    makeClip(inputPath, 6, 440);
  }
  // Long enough at 240x160 @ 60 fps raw to need the >32 MB layout
  const longPath = join(tempDir, "long.mp4");
  makeClip(longPath, 16, 220);

  const one = [{ path: inputPath, name: "Smoke clip" }];
  const base = { compress: false, audioMode: "source", audioSpv: 304, audioCodec: "pcm", dither: "none", allowLarge: false };
  const cases = [
    { ...base, videos: one, width: 120, height: 80, vblanksPerFrame: 5 },
    { ...base, videos: one, width: 240, height: 160, vblanksPerFrame: 3, compress: true, audioSpv: 608, dither: "bayer" },
    { ...base, videos: one, width: 96, height: 64, vblanksPerFrame: 6, audioMode: "none", audioSpv: 152, dither: "sierra2_4a" },
    {
      ...base,
      videos: [...one, { path: inputPath, name: "Second" }, { path: inputPath, name: "Third" }],
      width: 144, height: 96, vblanksPerFrame: 4, audioCodec: "adpcm", audioSpv: 228,
    },
    { ...base, videos: [{ path: longPath, name: "Large" }], width: 240, height: 160, vblanksPerFrame: 1, allowLarge: true },
  ];
  for (const [i, c] of cases.entries()) {
    const outputPath = join(tempDir, `smoke-${i}.gba`);
    const t0 = Date.now();
    await convertToGba({ ...c, outputPath, romTitle: "Smoke Test" }, resourcesRoot, (event) => {
      if (event.kind === "error") console.error(`ERROR: ${event.message}`);
    });
    const { frames, size, large } = checkRom(await readFile(outputPath), c);
    console.log(
      `[smoke-test] OK ${c.videos.length} video(s) ${c.width}x${c.height} vpf=${c.vblanksPerFrame} ` +
        `lz77=${c.compress} ${c.audioCodec}${large ? " LARGE" : ""} -> ${frames} frames, ` +
        `${(size / MB).toFixed(1)} MB in ${Date.now() - t0} ms`
    );
  }

  // Over 32 MB without allowLarge must be refused with a clear message
  let refused = false;
  try {
    await convertToGba(
      { ...cases[4], allowLarge: false, outputPath: join(tempDir, "too-big.gba"), romTitle: "Smoke Test" },
      resourcesRoot,
      () => {}
    );
  } catch (err) {
    refused = /exceed the 32 MB/.test(err.message);
  }
  assert(refused, "a >32 MB ROM without allowLarge should be refused");
  console.log("[smoke-test] OK size limit enforced");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
