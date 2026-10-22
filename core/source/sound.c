#include "common.h"
#include "romio.h"

// Direct Sound channel A streaming, two modes behind one API:
//
// - Direct PCM: DMA1 reads signed 8-bit samples straight from ROM. Zero CPU,
//   gapless. Used for uncompressed audio in the normal (<= 32 MiB) build.
// - Ring: per-VBlank blocks (ADPCM decoded, or PCM copied through the Matrix
//   window in the large build) are written into a tightly-packed PCM ring.
//   DMA streams through the ring continuously and is restarted ONLY when it
//   wraps, every RING_FRAMES VBlanks (~3.7 Hz), instead of every frame. That
//   avoids the per-VBlank pops / VHS crackle of stopping DMA 60 times a
//   second. The VBlank ISR keeps the ring topped up so the main loop can
//   decode video freely.
//
// Timer period: period * spv = 280896 cycles, so A/V sync stays drift-free.
//
// Modified from GBA Video Maker by Bytecodes Software (not the original).

#define DMA_TIMING_FIFO (3 << 28)
#define SND_BUF_MAX     608
#define RING_FRAMES     16          // DMA wrap every 16 VBlanks (~0.27 s)

static u32 s_src;            // ROM address of the track (see romio.h)
static u32 s_spv;
static u32 s_block;          // absolute block (VBlank) currently playing
static u32 s_slot;           // ring slot currently playing (0 .. RING_FRAMES-1)
static u32 s_nblocks;
static int s_adpcm;
static int s_ring_mode;      // 0: direct PCM DMA from ROM, 1: ring
static int s_on, s_paused;

// Tightly packed PCM ring: slot i occupies [i*spv .. (i+1)*spv)
ALIGN(4) static s8 s_ring[RING_FRAMES * SND_BUF_MAX];

static const u16 ima_step[89] = {
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41,
    45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190,
    209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724,
    796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272,
    2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132,
    7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500,
    20350, 22385, 24623, 27086, 29794, 32767,
};
static const s8 ima_index[8] = { -1, -1, -1, -1, 2, 4, 6, 8 };

static u32 adpcm_block_bytes(void)
{
    return 4 + s_spv / 2;
}

static s8 *ring_slot(u32 slot)
{
    return s_ring + slot * s_spv;
}

static void adpcm_decode(const u8 *p, s8 *dst)
{
    int pred = (s16)(p[0] | (p[1] << 8));
    int idx = p[2];
    const u8 *nib = p + 4;

    for (u32 i = 0; i < s_spv; i++)
    {
        int code = (i & 1) ? (nib[i >> 1] >> 4) : (nib[i >> 1] & 0xF);
        int step = ima_step[idx];
        int diff = step >> 3;
        if (code & 1) diff += step >> 2;
        if (code & 2) diff += step >> 1;
        if (code & 4) diff += step;
        pred = (code & 8) ? pred - diff : pred + diff;
        if (pred > 32767) pred = 32767;
        if (pred < -32768) pred = -32768;
        idx += ima_index[code & 7];
        if (idx < 0) idx = 0;
        if (idx > 88) idx = 88;
        dst[i] = pred >> 8;
    }
}

// Produce VBlank `block` of the track as spv PCM samples
static void fill_block(u32 block, s8 *dst)
{
    if (block >= s_nblocks)
    {
        for (u32 i = 0; i < s_spv; i++)
            dst[i] = 0;
        return;
    }

    if (s_adpcm)
    {
        ALIGN(4) u8 tmp[4 + SND_BUF_MAX / 2];
        u32 bytes = adpcm_block_bytes();
        adpcm_decode(rom_view(s_src + block * bytes, bytes, tmp), dst);
    }
    else
        rom_read(s_src + block * s_spv, dst, s_spv);
}

static void dma_start(const void *src)
{
    REG_DMA1CNT = 0;
    REG_DMA1SAD = (u32)src;
    REG_DMA1DAD = (u32)&REG_FIFO_A;
    REG_DMA1CNT = DMA_DST_FIXED | DMA_REPEAT | DMA_32 | DMA_TIMING_FIFO
                | DMA_ENABLE | 4;
}

// Fill the whole ring from the current play head and start streaming it on
// a VBlank boundary, so the wrap restarts stay phase-locked to the sample
// timer (exactly RING_FRAMES * spv samples per wrap)
static void ring_start(void)
{
    for (u32 i = 0; i < RING_FRAMES; i++)
        fill_block(s_block + i, ring_slot(i));
    s_slot = 0;
    VBlankIntrWait();
    dma_start(s_ring);
}

// VBlank ISR: advance the play head, refill the slot we just left, and
// restart DMA only on ring wrap (once every RING_FRAMES frames).
void sound_vblank(void)
{
    if (!s_on || s_paused)
        return;

    // Direct PCM: only track the playhead so pause/resume can restart DMA
    // mid-stream.
    if (!s_ring_mode)
    {
        s_block++;
        return;
    }

    u32 finished = s_slot;
    s_slot++;
    s_block++;
    if (s_slot >= RING_FRAMES)
    {
        s_slot = 0;
        dma_start(s_ring);          // wrap: only DMA restart in the whole frame
    }

    // Refill the free slot with audio RING_FRAMES ahead of the play head
    fill_block(s_block + RING_FRAMES - 1, ring_slot(finished));
}

static void fifo_reset(void)
{
    REG_SNDSTAT   = 1 << 7;
    REG_SNDDMGCNT = 0;
    REG_SNDDSCNT  = (1 << 2)     // DS A: 100% volume
                  | (1 << 8)     // DS A: right speaker
                  | (1 << 9)     // DS A: left speaker
                  | (1 << 11);   // DS A: FIFO reset
}

void sound_track_start(u32 src, u32 spv, int adpcm, u32 total_samples,
                       u32 start_vbl)
{
    sound_track_stop();

    if (spv == 0 || spv > SND_BUF_MAX)
        spv = VMK_SND_DEF_SPV;
    s_src = src;
    s_spv = spv;
    s_adpcm = adpcm;
#ifdef VMK_BANKED
    s_ring_mode = 1;             // ROM data is only reachable by copying
#else
    s_ring_mode = adpcm;
#endif
    s_nblocks = total_samples / spv;
    s_block = start_vbl;
    s_paused = 0;

    fifo_reset();
    REG_TM0D   = 65536 - (VMK_CYCLES_PER_VBL / spv);
    REG_TM0CNT = 0;

    if (s_ring_mode)
        ring_start();
    else
        dma_start((const void *)(src + start_vbl * spv));
    REG_TM0CNT = TM_ENABLE;
    s_on = 1;
}

void sound_track_tick(void)
{
    // Ring mode is entirely ISR-driven via sound_vblank().
}

void sound_track_pause(void)
{
    s_paused = 1;
    REG_TM0CNT = 0;
    REG_DMA1CNT = 0;
}

void sound_track_resume(void)
{
    if (!s_on)
        return;

    // Pause stops DMA; DirectSound FIFO must be reset before a fresh stream.
    // s_paused stays set until DMA is running again, so the VBlank ISR can't
    // advance the play head while the ring is being rebuilt.
    fifo_reset();

    if (s_ring_mode)
    {
        // Rebuild the ring from the current play head so DMA can always
        // start at s_ring and wrap cleanly (same as a fresh start).
        ring_start();
    }
    else
    {
        // Direct PCM: pause cleared DMA1 — restart from the tracked playhead.
        VBlankIntrWait();
        dma_start((const void *)(s_src + s_block * s_spv));
    }
    REG_TM0CNT = TM_ENABLE;
    s_paused = 0;
}

void sound_track_stop(void)
{
    s_on = 0;
    s_paused = 0;
    REG_TM0CNT  = 0;
    REG_DMA1CNT = 0;
    REG_SNDDSCNT = 0;
    REG_SNDSTAT  = 0;
}
