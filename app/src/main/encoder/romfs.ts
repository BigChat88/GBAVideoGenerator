// VMK filesystem packer + GBA header patching: the TypeScript counterpart of
// GbaVideo's tool/romfs.py, laid out exactly as core/source/vmkfs.h expects.
//
//   "VMKFS01\0" | version u32 | count u32 | entries[count] (64 B each) | data
//
// Offsets inside entries are relative to the filesystem header and 4-byte
// aligned (the player uses 32-bit copies).
//
// Two ROM layouts:
// - normal (<= 32 MiB): player.gba, 0xFF padding to a 256-byte boundary (the
//   player scans for the magic in 256-byte steps), filesystem.
// - large (32..64 MiB, mGBA only): loader.gba at 0, player_mb.gba at 0x2000
//   (copied to EWRAM by the loader), filesystem at 0x42000 — the constants in
//   core/loader/loader.s and VMK_BANKED_FS_PHYS in core/source/romio.h.

const MAGIC = Buffer.from("VMKFS01\0", "latin1");
const VERSION = 1;
const HEADER_SIZE = 16;
const ENTRY_SIZE = 64;
const FS_ALIGN = 256;

const LARGE_PLAYER_PHYS = 0x2000;
const LARGE_FS_PHYS = 0x42000;
const LARGE_PLAYER_MAX = LARGE_FS_PHYS - LARGE_PLAYER_PHYS; // 256 KiB of EWRAM
const LARGE_LOADER_MAX = 0x1000; // the Matrix window starts at 0x1000

export const TYPE_VIDEO = 2;
export const MAX_ENTRIES = 256; // VMK_MAX_ENTRIES
// VmkEntry.reserved2 flags (VMK_FLAG_* in vmkfs.h)
export const FLAG_COMPRESSED = 1;
export const FLAG_ADPCM = 4;

export interface VideoEntry {
  name: string;
  data: Buffer;
  vblanksPerFrame: number; // param1
  frameCount: number; // param2
  width: number;
  height: number;
  audioSpv: number;
  flags: number;
}

export interface PlayerAssets {
  player: Buffer; // player.gba
  playerMb: Buffer; // player_mb.gba
  loader: Buffer; // loader.gba
}

const align4 = (n: number) => (n + 3) & ~3;

/** Sanitizes a name for the GBA font: printable ASCII only. */
export function asciiName(name: string, maxLen: number): string {
  const clean = name
    .replace(/[^\x20-\x7e]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean.slice(0, maxLen);
}

function fsHeaderSize(count: number): number {
  return align4(HEADER_SIZE + ENTRY_SIZE * count);
}

function buildFs(entries: VideoEntry[]): Buffer {
  if (entries.length === 0 || entries.length > MAX_ENTRIES) {
    throw new Error(`A ROM holds 1 to ${MAX_ENTRIES} videos (got ${entries.length}).`);
  }
  let offset = fsHeaderSize(entries.length);
  const total = entries.reduce((n, e) => n + align4(e.data.length), offset);
  const fs = Buffer.alloc(total);

  MAGIC.copy(fs, 0);
  fs.writeUInt32LE(VERSION, 8);
  fs.writeUInt32LE(entries.length, 12);

  entries.forEach((entry, i) => {
    const e = HEADER_SIZE + i * ENTRY_SIZE;
    fs.writeUInt32LE(TYPE_VIDEO, e);
    fs.write(asciiName(entry.name, 31) || "video", e + 4, 32, "latin1");
    fs.writeUInt32LE(offset, e + 36); // offset
    fs.writeUInt32LE(entry.data.length, e + 40); // size
    fs.writeUInt32LE(entry.vblanksPerFrame, e + 44); // param1
    fs.writeUInt32LE(entry.frameCount, e + 48); // param2
    fs.writeUInt32LE(offset, e + 52); // thumb_offset: no thumbnail
    fs.writeUInt32LE(((entry.width << 16) | entry.height) >>> 0, e + 56); // reserved1
    fs.writeUInt32LE(((entry.audioSpv << 16) | entry.flags) >>> 0, e + 60); // reserved2
    entry.data.copy(fs, offset);
    offset += align4(entry.data.length);
  });
  return fs;
}

/** Size of the ROM buildRom() would produce for `count` videos of `dataSize` bytes in total. */
export function romSize(assets: PlayerAssets, large: boolean, count: number, dataSize: number): number {
  const fsStart = large ? LARGE_FS_PHYS : Math.ceil(assets.player.length / FS_ALIGN) * FS_ALIGN;
  return fsStart + fsHeaderSize(count) + dataSize + 3 * count;
}

function checkRaw(rom: Buffer, name: string): void {
  if (rom.length < 0xc0 || rom.subarray(0, 4).toString("latin1") === "\x7fELF") {
    throw new Error(`${name} is not a raw GBA ROM image.`);
  }
}

function pad(length: number): Buffer {
  return Buffer.alloc(length, 0xff);
}

/**
 * Player + filesystem, with the cartridge header title rewritten. The header
 * checksum only covers the header itself, so it is recomputed here and the
 * appended data needs no further fixing (no gbafix step).
 */
export function buildRom(assets: PlayerAssets, entries: VideoEntry[], title: string, large: boolean): Buffer {
  const fs = buildFs(entries);
  let rom: Buffer;
  if (large) {
    const { loader, playerMb } = assets;
    checkRaw(loader, "loader.gba");
    checkRaw(playerMb, "player_mb.gba");
    if (loader.length > LARGE_LOADER_MAX || playerMb.length > LARGE_PLAYER_MAX) {
      throw new Error("loader.gba / player_mb.gba are too big for the large ROM layout.");
    }
    rom = Buffer.concat([
      loader,
      pad(LARGE_PLAYER_PHYS - loader.length),
      playerMb,
      pad(LARGE_FS_PHYS - LARGE_PLAYER_PHYS - playerMb.length),
      fs,
    ]);
  } else {
    checkRaw(assets.player, "player.gba");
    const gap = (FS_ALIGN - (assets.player.length % FS_ALIGN)) % FS_ALIGN;
    rom = Buffer.concat([assets.player, pad(gap), fs]);
  }
  patchHeaderTitle(rom, title);
  return rom;
}

/** Writes the 12-char header title (0xA0) and fixes the complement check (0xBD). */
export function patchHeaderTitle(rom: Buffer, title: string): void {
  rom.fill(0, 0xa0, 0xac);
  rom.write(asciiName(title, 12).toUpperCase(), 0xa0, 12, "latin1");
  let sum = 0;
  for (let i = 0xa0; i <= 0xbc; i++) sum += rom[i];
  rom[0xbd] = (-(sum + 0x19)) & 0xff;
}
