#ifndef MATRIX_H
#define MATRIX_H

#include <tonc.h>

// Majesco / mGBA Matrix Memory mapper (GBA Video 64 MiB carts).
// Command block at 0x08800180: paddr, vaddr, nblocks, commit.
// mGBA matches (addr & 0x01FFFF00) == 0x00800100 and uses (addr & 0x3C).

#define MATRIX_REG_BASE  0x08800180
#define MATRIX_CMD       (*(vu32 *)(MATRIX_REG_BASE + 0x0))
#define MATRIX_PADDR     (*(vu32 *)(MATRIX_REG_BASE + 0x4))
#define MATRIX_VADDR     (*(vu32 *)(MATRIX_REG_BASE + 0x8))
#define MATRIX_NBLOCKS   (*(vu32 *)(MATRIX_REG_BASE + 0xC))

#define MATRIX_WINDOW_CPU  0x08001000u   // safe window (skips unremapable header)
#define MATRIX_CHUNK       0x1000u       // 4 KiB per map (8 blocks of 512)

void matrix_map(u32 paddr, u32 vaddr, u32 nbytes);
void matrix_read(u32 phys, void *dst, u32 len);

#endif
