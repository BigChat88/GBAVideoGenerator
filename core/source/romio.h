#ifndef ROMIO_H
#define ROMIO_H

#include <string.h>
#include <tonc.h>

// Cartridge data access, shared by both player builds:
//
// - Normal build (ROMs up to 32 MiB): the whole cartridge is mapped, so a
//   "ROM address" is just a pointer and data is used in place (DMA audio
//   straight from ROM, LZ77 straight to VRAM).
// - Large build (VMK_BANKED, 32..64 MiB, mGBA only): the cartridge is a
//   Matrix-mapped GBA Video style cart that only exposes a 4 KiB window, so a
//   "ROM address" is a physical file offset and every read goes through
//   matrix_read() into RAM. The player itself runs from EWRAM (multiboot
//   image copied there by core/loader/loader.s).

#ifdef VMK_BANKED
#include "matrix.h"

// Physical layout written by the desktop app (see app encoder/romfs.ts):
// loader at 0, player image at 0x2000 (256 KiB max), filesystem after it.
#define VMK_BANKED_FS_PHYS 0x42000u

static inline void rom_read(u32 addr, void *dst, u32 len)
{
    matrix_read(addr, dst, len);
}

// Returns `len` bytes at `addr`, copied into `staging`
static inline const u8 *rom_view(u32 addr, u32 len, void *staging)
{
    matrix_read(addr, staging, len);
    return (const u8 *)staging;
}

static inline u32 rom_u32(u32 addr)
{
    u32 v;
    matrix_read(addr, &v, 4);
    return v;
}

#else

static inline void rom_read(u32 addr, void *dst, u32 len)
{
    memcpy(dst, (const void *)addr, len);
}

// Data is used in place: no copy
static inline const u8 *rom_view(u32 addr, u32 len, void *staging)
{
    (void)len;
    (void)staging;
    return (const u8 *)addr;
}

static inline u32 rom_u32(u32 addr)
{
    return *(const u32 *)addr;
}

#endif

#endif
