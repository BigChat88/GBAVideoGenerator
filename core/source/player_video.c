// Modified from GBA Video Maker by Bytecodes Software (not the original):
// playlist-aware, holds the last frame with a play icon at the end, and
// reads the cartridge through romio.h so it also runs Matrix-banked.

#include "common.h"
#include "romio.h"

// Mode 4 page-flipped video: WxH 8bpp frames with a per-frame palette,
// hardware-scaled by the BG2 affine matrix to fill the 240x160 screen.
// Resolution (up to 240x160) and frame rate (vblanks per frame) come from
// the filesystem entry. Frame pacing and the audio stream are both locked to
// the VBlank (audio is an exact number of samples per VBlank), so A/V sync
// is drift-free by construction.
//
// The encoder reserves palette indices 252..255 for the on-screen overlay
// (frames are quantized to 252 colors on the PC side).

#define PAL_UI_DARK  252
#define PAL_UI_BLUE  253
#define PAL_UI_WHITE 254

#define PX2(i) ((u16)((i) | ((i) << 8)))   // two 8bpp pixels per VRAM write

#define BAR_SHOW_VBL 150    // how long the bar stays after the last seek

typedef struct VidCtx
{
    u32 base;             // ROM address of the entry data (see romio.h)
    u32 w, h, fbytes, nframes, vpf;
    int comp;
} VidCtx;

// Decompression target for sub-fullwidth LZ77 frames (pixels only; the
// palette is stored uncompressed next to each frame)
EWRAM_BSS static u8 s_fbuf[SCREEN_W * SCREEN_H];
#ifdef VMK_BANKED
// Frames are copied out of the Matrix window before use. Sized for the
// worst-case LZ77 expansion of a 240x160 frame (+1/8 flags, + palette).
#define STAGE_BYTES (VMK_VID_PAL_BYTES + 4 + SCREEN_W * SCREEN_H * 9 / 8 + 16)
EWRAM_BSS static u32 s_stage[STAGE_BYTES / 4];
#else
#define s_stage NULL
#endif
// Palette of the most recently prepared frame, applied at flip time
ALIGN(4) static u8 s_next_pal[VMK_VID_PAL_BYTES];

// State of the last played video, for player_hold_end()
static VidCtx s_last;
static u32 s_last_frame;
static int s_last_page;

static u16 *page_ptr(int page)
{
    return (u16 *)(page ? 0x0600A000 : 0x06000000);
}

// Compressed layout: u32 offsets[nframes + 1] at the start of the data
static u32 frame_offset(const VidCtx *v, u32 f)
{
    return rom_u32(v->base + f * 4);
}

static u32 audio_addr(const VidCtx *v)
{
    return v->comp ? v->base + frame_offset(v, v->nframes)
                   : v->base + v->nframes * v->fbytes;
}

// Prepare frame f into a page: decompress if needed, blit the pixels, and
// stash the frame's palette for the upcoming flip.
static void prep_frame(const VidCtx *v, u32 f, u16 *page)
{
    if (v->comp)
    {
        // Compressed frame: [raw 512-byte palette][LZ77 pixels]
        u32 off = frame_offset(v, f);
        u32 len = frame_offset(v, f + 1) - off;
        const u8 *src = rom_view(v->base + off, len, s_stage);
        memcpy32(s_next_pal, src, VMK_VID_PAL_BYTES / 4);
        src += VMK_VID_PAL_BYTES;

        if (v->w == SCREEN_W)
        {
            // Full-width rows are contiguous in VRAM: decompress straight
            // into the page, skipping the EWRAM bounce buffer entirely
            LZ77UnCompVram(src, page);
        }
        else
        {
            LZ77UnCompWram(src, s_fbuf);
            u8 *dst = (u8 *)page;
            for (u32 y = 0; y < v->h; y++)
                memcpy32(dst + y * SCREEN_W, s_fbuf + y * v->w, v->w / 4);
        }
        return;
    }

    const u8 *frame = rom_view(v->base + f * v->fbytes, v->fbytes, s_stage);
    const u8 *pix = frame + VMK_VID_PAL_BYTES;
    u8 *dst = (u8 *)page;
    for (u32 y = 0; y < v->h; y++)
        memcpy32(dst + y * SCREEN_W, pix + y * v->w, v->w / 4);

    memcpy32(s_next_pal, frame, VMK_VID_PAL_BYTES / 4);
}

static void apply_palette(void)
{
    memcpy32(pal_bg_mem, s_next_pal, VMK_VID_PAL_BYTES / 4);
    pal_bg_mem[PAL_UI_DARK]  = RGB15(1, 3, 8);
    pal_bg_mem[PAL_UI_BLUE]  = RGB15(8, 18, 31);
    pal_bg_mem[PAL_UI_WHITE] = RGB15(31, 31, 31);
}

static void show_page(int page)
{
    REG_DISPCNT = DCNT_MODE4 | DCNT_BG2 | (page ? DCNT_PAGE : 0);
}

// Overlay metrics scaled to the source resolution (all x values kept even
// because VRAM only accepts 16-bit writes)
static int bar_max_height(const VidCtx *v)
{
    return (int)(v->h * 12 / 80) & ~1;
}

// Seek bar overlay, drawn in WxH source space onto a page.
// It slides up from the bottom edge: only the top `anim` rows are shown.
static void draw_overlay(const VidCtx *v, u16 *page, u32 f, int anim,
                         int paused)
{
    if (anim <= 0)
        return;

    u8 *base = (u8 *)page;
    int bar_h = bar_max_height(v);
    int y0 = (int)v->h - anim;
    int track_x = (int)(v->w * 18 / 120) & ~1;
    int track_w = (int)(v->w * 96 / 120) & ~1;
    int track_r0 = bar_h / 3;
    int track_r1 = track_r0 + (bar_h / 3 > 2 ? bar_h / 3 : 2);
    int icon_x = (int)(v->w * 6 / 120) & ~1;

    for (int y = y0; y < (int)v->h; y++)
    {
        int r = y - y0;
        u16 *row = (u16 *)(base + y * SCREEN_W);
        u16 fill = (r == 0) ? PX2(PAL_UI_WHITE) : PX2(PAL_UI_DARK);
        for (u32 i = 0; i < v->w / 2; i++)
            row[i] = fill;

        if (r >= track_r0 && r < track_r1)
        {
            int w = (int)((u64)track_w * f
                          / (v->nframes ? v->nframes : 1)) & ~1;
            u16 *track = (u16 *)(base + y * SCREEN_W + track_x);
            for (int i = 0; i < w / 2; i++)
                track[i] = PX2(PAL_UI_BLUE);
            if (w / 2 < track_w / 2)
                track[w / 2] = PX2(PAL_UI_WHITE);   // position marker
        }
        if (paused && r >= track_r0 - 1 && r <= track_r1)
        {
            // Pause icon: two small white bars left of the track
            *(u16 *)(base + y * SCREEN_W + icon_x) = PX2(PAL_UI_WHITE);
            *(u16 *)(base + y * SCREEN_W + icon_x + 4) = PX2(PAL_UI_WHITE);
        }
    }
}

// Restore the bottom `rows` of clean video into `page` so a shrinking
// seek bar does not leave stale overlay pixels behind.
static void restore_overlay_area(const VidCtx *v, u32 f, u16 *page, int rows)
{
    if (rows <= 0)
        return;
    int y0 = (int)v->h - rows;
    if (y0 < 0)
        y0 = 0;

    if (v->comp)
    {
        prep_frame(v, f, page);
        return;
    }

    u32 row0 = v->base + f * v->fbytes + VMK_VID_PAL_BYTES + y0 * v->w;
    const u8 *pix = rom_view(row0, (v->h - y0) * v->w, s_stage);
    u8 *dst = (u8 *)page;
    for (int y = y0; y < (int)v->h; y++)
        memcpy32(dst + y * SCREEN_W, pix + (y - y0) * v->w, v->w / 4);
}

// Present `page` during VBlank. Overlay is burned into the page BEFORE the
// flip so the bar never pops in one frame late (that was the seek flicker).
static void present_page(const VidCtx *v, int page, u32 f, int anim,
                         int paused)
{
    draw_overlay(v, page_ptr(page), f, anim, paused);
    apply_palette();
    show_page(page);
}

// Horizontal run of `len` pixels at (x, y) in source space, both even
static void hrun(u16 *page, int x, int y, int len, u8 idx)
{
    u16 *p = (u16 *)((u8 *)page + y * SCREEN_W + x);
    for (int i = 0; i < len / 2; i++)
        p[i] = PX2(idx);
}

// Big "play again" icon: a dark rounded square with a white triangle,
// centered on the frame and sized from its height
static void draw_play_icon(const VidCtx *v, u16 *page)
{
    int s = (int)(v->h * 2 / 5) & ~1;            // backdrop size
    int x0 = ((int)v->w - s) / 2 & ~1;
    int y0 = ((int)v->h - s) / 2;
    int corner = s / 6 & ~1;

    for (int r = 0; r < s; r++)
    {
        // Trim the corners of the backdrop
        int d = r < corner ? corner - r : (r >= s - corner ? r - (s - corner - 1) : 0);
        int cut = d ? (d + 1) & ~1 : 0;
        hrun(page, x0 + cut, y0 + r, s - 2 * cut, PAL_UI_DARK);
    }

    // Right-pointing triangle, nudged right to look optically centered
    int th = s * 3 / 5 & ~1;                     // triangle height
    int tx = x0 + (s - th * 7 / 8) / 2 + 2;
    tx &= ~1;
    int ty = y0 + (s - th) / 2;
    for (int r = 0; r < th; r++)
    {
        int dist = r < th / 2 ? r : th - 1 - r;  // distance from the tip rows
        int len = (dist * 2 * 7 / 8 + 2) & ~1;
        hrun(page, tx, ty + r, len, PAL_UI_WHITE);
    }
}

int player_video_run(const VmkEntry *e, int playlist)
{
    VidCtx v;
    v.base = vmk_data(e->offset);
    v.nframes = e->param2;
    v.vpf = e->param1;
    v.comp = e->reserved2 & VMK_FLAG_COMPRESSED;
    v.w = e->reserved1 >> 16;
    v.h = e->reserved1 & 0xFFFF;
    if (v.w == 0 || v.h == 0)
    {
        v.w = VMK_VID_DEF_W;
        v.h = VMK_VID_DEF_H;
    }
    v.fbytes = VMK_VID_PAL_BYTES + v.w * v.h;

    int adpcm = (e->reserved2 & VMK_FLAG_ADPCM) != 0;
    u32 aspv = e->reserved2 >> 16;             // audio samples per vblank
    if (aspv == 0)
        aspv = VMK_SND_DEF_SPV;
    u32 spf = v.vpf * aspv;                    // audio samples per video frame
    u32 audio = audio_addr(&v);
    u32 total_samples = v.nframes * spf;
    u32 seek_frames = SEEK_VBLANKS / v.vpf;

    memset32(page_ptr(0), 0, SCREEN_W * SCREEN_H / 4);
    memset32(page_ptr(1), 0, SCREEN_W * SCREEN_H / 4);

    // Affine scale: texel step = source_size / screen_size, in .8 fixed point
    REG_BG2PA = (v.w << 8) / SCREEN_W;
    REG_BG2PB = 0;
    REG_BG2PC = 0;
    REG_BG2PD = (v.h << 8) / SCREEN_H;
    REG_BG2X = 0;
    REG_BG2Y = 0;

    prep_frame(&v, 0, page_ptr(0));

    VBlankIntrWait();
    present_page(&v, 0, 0, 0, 0);
    int cur = 0;
    sound_track_start(audio, aspv, adpcm, total_samples, 0);

    if (v.nframes > 1)
        prep_frame(&v, 1, page_ptr(1));

    // Playback clock: vbl = g_vbl_count - clock_base. The hardware counter
    // keeps ticking even if we overrun a frame (slow decompression), in
    // which case the video skips ahead to stay in sync with the audio.
    //
    // Adaptive pacing: `pending` is the frame already decompressed into the
    // back page. It is shown as soon as the clock reaches it (even a bit
    // late), and the next frame is prepped `1 + lateness` ahead. Busy
    // scenes that decompress slowly settle into a steady half/third-rate
    // cadence with no wasted decompression work.
    u32 clock_base = g_vbl_count;
    u32 f = 0, vbl = 0;
    u32 pending = (v.nframes > 1) ? 1 : v.nframes;   // nframes = none
    int paused = 0, need_restart = 0, hold = 0;
    int anim = 0, bar_timer = 0, prev_anim = 0;
    int result = -1;

    while (result < 0)
    {
        VBlankIntrWait();
        sound_track_tick();
        if (!paused)
            vbl = g_vbl_count - clock_base;
        key_poll();

        if (playlist)
        {
            if (key_hit(KEY_B))
                result = VID_MENU;
            else if (key_hit(KEY_R))
                result = VID_NEXT;
            else if (key_hit(KEY_L))
                result = VID_PREV;
            if (result >= 0)
                break;
        }

        // Frame to jump to this iteration (seek or restart), or -1
        int target = -1;

        int pause_toggled = 0;
        if (key_hit(KEY_START) || key_hit(KEY_SELECT) || key_hit(KEY_A))
        {
            paused = !paused;
            if (paused)
                sound_track_pause();
            else
            {
                clock_base = g_vbl_count - vbl;   // resume the clock
                if (need_restart)
                {
                    sound_track_start(audio, aspv, adpcm, total_samples,
                                      f * v.vpf);
                    need_restart = 0;
                }
                else
                    sound_track_resume();
            }
            bar_timer = BAR_SHOW_VBL;          // reveal the bar on pause too
            pause_toggled = 1;
        }

        // B (single video): back to the first frame, keeping the pause state
        if (!playlist && key_hit(KEY_B))
            target = 0;

        // Seek: single press, then auto-repeat after a 1/3 s hold
        if (key_is_down(KEY_RIGHT) || key_is_down(KEY_LEFT))
            hold++;
        else
            hold = 0;
        int repeat = (hold >= 20 && hold % 10 == 0);
        if (key_hit(KEY_RIGHT) || (key_is_down(KEY_RIGHT) && repeat))
            target = (f + seek_frames < v.nframes - 1) ? f + seek_frames
                                                       : v.nframes - 1;
        else if (key_hit(KEY_LEFT) || (key_is_down(KEY_LEFT) && repeat))
            target = (f > seek_frames) ? f - seek_frames : 0;

        if (target >= 0)
        {
            bar_timer = BAR_SHOW_VBL;
            if (anim < 2)
                anim = 2;   // bar visible on the very first seek frame
        }

        int flipped = 0;

        if (target >= 0 && (u32)target != f)
        {
            f = (u32)target;
            cur ^= 1;
            prep_frame(&v, f, page_ptr(cur));
            VBlankIntrWait();   // flip only after prep finishes
            present_page(&v, cur, f, anim, paused);
            flipped = 1;
            prev_anim = anim;

            // (Re)start the clock and the audio right at the flip
            vbl = f * v.vpf;
            clock_base = g_vbl_count - vbl;
            if (paused)
                need_restart = 1;
            else
                sound_track_start(audio, aspv, adpcm, total_samples,
                                  f * v.vpf);

            pending = v.nframes;
            if (f + 1 < v.nframes)
            {
                prep_frame(&v, f + 1, page_ptr(cur ^ 1));
                pending = f + 1;
            }
        }
        else if (target < 0 && !paused)
        {
            u32 ft = vbl / v.vpf;      // frame the audio clock says is due
            if (ft >= v.nframes)
            {
                result = VID_FINISHED; // the audio track has finished
                break;
            }

            if (pending < v.nframes && ft >= pending)
            {
                // Show the prepared frame (possibly a bit late). Overlay is
                // stamped on BEFORE the flip so the bar does not blink off.
                u32 late = ft - pending;
                f = pending;
                cur ^= 1;
                present_page(&v, cur, f, anim, paused);
                flipped = 1;
                prev_anim = anim;

                // Prep further ahead when we are falling behind, so slow
                // scenes drop into a steady skip cadence instead of
                // wasting decompression work on frames shown late
                u32 next = f + 1 + late;
                if (next < v.nframes)
                {
                    prep_frame(&v, next, page_ptr(cur ^ 1));
                    pending = next;
                }
                else
                    pending = v.nframes;
            }
        }

        // Slide the bar in while active, out when the timer expires
        if (bar_timer > 0)
        {
            bar_timer--;
            if (anim < bar_max_height(&v))
                anim += 2;
        }
        else if (anim > 0 && !paused)
            anim -= 2;
        if (anim < 0)
            anim = 0;

        // Anim / pause-icon update on the visible page (no frame flip).
        // Pause toggles must redraw even when anim is unchanged, and must
        // restore clean video first so the pause icon can appear/disappear.
        if (!flipped && (anim != prev_anim || pause_toggled))
        {
            int restore_rows = prev_anim > anim ? prev_anim : anim;
            if (restore_rows < 2)
                restore_rows = bar_max_height(&v);
            if (anim < prev_anim || pause_toggled)
            {
                restore_overlay_area(&v, f, page_ptr(cur), restore_rows);
                if (v.comp)
                    apply_palette();
            }
            draw_overlay(&v, page_ptr(cur), f, anim, paused);
        }
        prev_anim = anim;
    }

    sound_track_stop();
    s_last = v;
    s_last_frame = f;
    s_last_page = cur;
    return result;
}

int player_hold_end(void)
{
    // Clean copy of the last frame (drops any seek bar), then the icon
    u16 *page = page_ptr(s_last_page);
    prep_frame(&s_last, s_last_frame, page);
    draw_play_icon(&s_last, page);
    VBlankIntrWait();
    apply_palette();

    while (1)
    {
        VBlankIntrWait();
        key_poll();
        if (key_hit(KEY_START) || key_hit(KEY_A))
            return 1;
        if (key_hit(KEY_B))
            return 0;
    }
}
