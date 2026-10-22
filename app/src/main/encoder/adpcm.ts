// IMA ADPCM (4-bit) as decoded by core/source/sound.c: a sequence of
// independent per-VBlank blocks [s16 predictor][u8 step index][u8 pad]
// [spv/2 nibble bytes], so seeking is trivial (block n == VBlank n) and the
// GBA decoder is stateless across blocks. Port of GbaVideo's adpcm_encode.

const IMA_STEP = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767,
];
const IMA_INDEX = [-1, -1, -1, -1, 2, 4, 6, 8];

export function adpcmBlockBytes(spv: number): number {
  return 4 + spv / 2;
}

/** Encodes `blocks * spv` samples of s16le PCM (zero-padded) into ADPCM blocks. */
export function adpcmEncode(pcm: Buffer, spv: number, blocks: number): Buffer {
  const blockBytes = adpcmBlockBytes(spv);
  const out = Buffer.alloc(blocks * blockBytes);
  const available = Math.floor(pcm.length / 2);
  let pred = 0;
  let idx = 0;

  for (let b = 0; b < blocks; b++) {
    const o = b * blockBytes;
    out.writeInt16LE(pred, o);
    out[o + 2] = idx;
    for (let i = 0; i < spv; i++) {
      const n = b * spv + i;
      const s = n < available ? pcm.readInt16LE(n * 2) : 0;
      const step = IMA_STEP[idx];
      let diff = s - pred;
      let code = 0;
      if (diff < 0) {
        code = 8;
        diff = -diff;
      }
      if (diff >= step) {
        code |= 4;
        diff -= step;
      }
      if (diff >= step >> 1) {
        code |= 2;
        diff -= step >> 1;
      }
      if (diff >= step >> 2) code |= 1;

      // Reconstruct exactly like the GBA decoder to stay bit-exact
      let d = step >> 3;
      if (code & 1) d += step >> 2;
      if (code & 2) d += step >> 1;
      if (code & 4) d += step;
      pred = code & 8 ? pred - d : pred + d;
      pred = Math.max(-32768, Math.min(32767, pred));
      idx = Math.max(0, Math.min(88, idx + IMA_INDEX[code & 7]));

      const at = o + 4 + (i >> 1);
      out[at] |= i & 1 ? code << 4 : code;
    }
  }
  return out;
}

/** Reference decoder (tests only): mirrors adpcm_decode() in sound.c. */
export function adpcmDecodeBlock(block: Buffer, spv: number): Int8Array {
  const out = new Int8Array(spv);
  let pred = block.readInt16LE(0);
  let idx = block[2];
  for (let i = 0; i < spv; i++) {
    const byte = block[4 + (i >> 1)];
    const code = i & 1 ? byte >> 4 : byte & 0xf;
    const step = IMA_STEP[idx];
    let d = step >> 3;
    if (code & 1) d += step >> 2;
    if (code & 2) d += step >> 1;
    if (code & 4) d += step;
    pred = code & 8 ? pred - d : pred + d;
    pred = Math.max(-32768, Math.min(32767, pred));
    idx = Math.max(0, Math.min(88, idx + IMA_INDEX[code & 7]));
    out[i] = pred >> 8;
  }
  return out;
}
