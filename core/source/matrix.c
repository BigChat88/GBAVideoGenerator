#include "matrix.h"

void matrix_map(u32 paddr, u32 vaddr, u32 nblocks)
{
    if (nblocks == 0)
        nblocks = 1;
    if (nblocks > 8)
        nblocks = 8;

    MATRIX_PADDR   = paddr & 0x03FFFFFF;
    MATRIX_VADDR   = vaddr & 0x007FFFFF;
    MATRIX_NBLOCKS = nblocks;
    MATRIX_CMD     = 0x11;
}

void matrix_read(u32 phys, void *dst, u32 len)
{
    u8 *out = (u8 *)dst;

    while (len > 0)
    {
        u32 aligned = phys & ~0x1FFu;
        u32 skip = phys - aligned;
        u32 avail = MATRIX_CHUNK - skip;
        u32 chunk = len < avail ? len : avail;
        u32 nblocks = (skip + chunk + 511) >> 9;
        if (nblocks == 0)
            nblocks = 1;
        if (nblocks > 8)
            nblocks = 8;

        /* Lock IRQs only for one window map+copy so audio ISR can run
         * between chunks and cannot remap mid-copy. */
        u16 ime = REG_IME;
        REG_IME = 0;

        matrix_map(aligned, 0x1000, nblocks);

        const u8 *src = (const u8 *)(MATRIX_WINDOW_CPU + skip);
        u32 copy = chunk;
        u32 mapped = (nblocks << 9) - skip;
        if (copy > mapped)
            copy = mapped;

        if (((u32)out & 1) == 0 && ((u32)src & 1) == 0 && (copy & 1) == 0)
        {
            if (((u32)out & 3) == 0 && ((u32)src & 3) == 0 && (copy & 3) == 0)
            {
                u32 *d = (u32 *)out;
                const u32 *s = (const u32 *)src;
                for (u32 i = 0; i < copy / 4; i++)
                    d[i] = s[i];
            }
            else
            {
                u16 *d = (u16 *)out;
                const u16 *s = (const u16 *)src;
                for (u32 i = 0; i < copy / 2; i++)
                    d[i] = s[i];
            }
        }
        else
        {
            for (u32 i = 0; i < copy; i++)
                out[i] = src[i];
        }

        REG_IME = ime;

        out += copy;
        phys += copy;
        len -= copy;
    }
}
