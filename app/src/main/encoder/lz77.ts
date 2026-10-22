// GBA BIOS LZ77 (type 0x10) compressor, decoded on the console by
// LZ77UnCompVram / LZ77UnCompWram.
//
// Matches never reference the previous byte (distance >= 2): VRAM only takes
// 16-bit writes, so LZ77UnCompVram can't copy from a byte it hasn't flushed
// yet. Longest matches are found through hash chains over the 4 KiB window.

const MIN_MATCH = 3;
const MAX_MATCH = 18;
const WINDOW = 4096;
const MIN_DISTANCE = 2;
const HASH_BITS = 14;
const HASH_MASK = (1 << HASH_BITS) - 1;
// Candidates checked per position: plenty for small frames, bounds the worst
// case on flat images where every position hashes alike.
const MAX_CHAIN = 128;

function hashAt(data: Uint8Array, i: number): number {
  return ((data[i] << 9) ^ (data[i + 1] << 4) ^ data[i + 2]) & HASH_MASK;
}

export function lz77Compress(data: Uint8Array): Buffer {
  const n = data.length;
  // Worst case: every byte a literal, plus one flag byte per 8 of them
  const out = Buffer.alloc(4 + n + Math.ceil(n / 8));
  out.writeUInt32LE((0x10 | (n << 8)) >>> 0, 0);
  let o = 4;

  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(n);
  let inserted = 0; // positions [0, inserted) are in the hash chains

  const insertUpTo = (end: number) => {
    const last = Math.min(end, n - 2);
    for (; inserted < last; inserted++) {
      const h = hashAt(data, inserted);
      prev[inserted] = head[h];
      head[h] = inserted;
    }
  };

  let i = 0;
  while (i < n) {
    const flagPos = o++;
    let flag = 0;
    for (let bit = 0; bit < 8 && i < n; bit++) {
      let bestLen = 0;
      let bestDist = 0;
      const maxLen = Math.min(MAX_MATCH, n - i);
      if (maxLen >= MIN_MATCH) {
        insertUpTo(i);
        let p = head[hashAt(data, i)];
        for (let chain = 0; p >= 0 && i - p <= WINDOW && chain < MAX_CHAIN; chain++, p = prev[p]) {
          if (i - p < MIN_DISTANCE) continue;
          // Overlapping matches (running past i) are fine: the decoder copies
          // byte by byte from its own output
          let len = 0;
          while (len < maxLen && data[p + len] === data[i + len]) len++;
          if (len > bestLen) {
            bestLen = len;
            bestDist = i - p;
            if (len === maxLen) break;
          }
        }
      }

      if (bestLen >= MIN_MATCH) {
        const disp = bestDist - 1;
        out[o++] = ((bestLen - MIN_MATCH) << 4) | (disp >> 8);
        out[o++] = disp & 0xff;
        flag |= 0x80 >> bit;
        i += bestLen;
      } else {
        out[o++] = data[i++];
      }
    }
    out[flagPos] = flag;
  }
  return out.subarray(0, o);
}

/** Reference decoder (tests only): mirrors the BIOS routine. */
export function lz77Decompress(src: Uint8Array): Buffer {
  const header = src[0] | (src[1] << 8) | (src[2] << 16) | (src[3] << 24);
  if ((header & 0xff) !== 0x10) throw new Error("not an LZ77 stream");
  const n = header >>> 8;
  const out = Buffer.alloc(n);
  let i = 4;
  let o = 0;
  while (o < n) {
    const flag = src[i++];
    for (let bit = 0; bit < 8 && o < n; bit++) {
      if (flag & (0x80 >> bit)) {
        const b0 = src[i++];
        const b1 = src[i++];
        const len = (b0 >> 4) + MIN_MATCH;
        const dist = (((b0 & 0x0f) << 8) | b1) + 1;
        for (let k = 0; k < len && o < n; k++, o++) out[o] = out[o - dist];
      } else {
        out[o++] = src[i++];
      }
    }
  }
  return out;
}
