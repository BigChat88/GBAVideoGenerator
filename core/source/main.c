// GBA Video Generator player.
// Modified from GBA Video Maker by Bytecodes Software (not the original):
// one video plays straight away; several get a list menu and play in order.

#include "common.h"
#include "ui.h"

const VmkHeader *g_fs;

// Hardware VBlank counter: incremented by the interrupt handler itself, so
// it keeps real time even when a main-loop iteration overruns a frame
// (e.g. slow LZ77 frame decompression). The player uses it as its clock.
volatile u32 g_vbl_count;

static const VmkEntry *s_videos[VMK_MAX_ENTRIES];
static int s_count;

static void vbl_isr(void)
{
    g_vbl_count++;
    sound_vblank();   // keep the audio ring fed even if the main loop is busy
}

static void collect_videos(void)
{
    for (u32 i = 0; i < g_fs->count; i++)
    {
        const VmkEntry *e = &g_fs->entries[i];
        if (e->type == VMK_TYPE_VIDEO && e->param1 && e->param2)
            s_videos[s_count++] = e;
    }
}

static void no_video_screen(void)
{
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    ui_clear(CLR_BG);
    ui_fill_rect(0, 0, SCREEN_W, 24, CLR_HEADER);
    ui_text_center(8, "GBA VIDEO GENERATOR", CLR_TITLE);
    ui_fill_rect(0, 24, SCREEN_W, 1, CLR_ACCENT);
    ui_text_center(70, "NO VIDEO IN THIS ROM", CLR_TEXT);
    ui_text_center(86, "BUILD IT WITH THE DESKTOP APP", CLR_TEXT_DIM);
    while (1)
        VBlankIntrWait();
}

int main(void)
{
    REG_WAITCNT = 0x4317;   // fast ROM waitstates (3/1) + prefetch

    irq_init(NULL);
    irq_add(II_VBLANK, vbl_isr);

    g_fs = vmk_find();
    if (g_fs)
        collect_videos();
    if (!s_count)
        no_video_screen();

    if (s_count == 1)
    {
        // Single video: play, hold the last frame, play again on START/A/B
        while (1)
        {
            player_video_run(s_videos[0], 0);
            player_hold_end();
        }
    }

    int sel = 0;
    while (1)
    {
        sel = menu_run(s_videos, s_count, sel);
        while (1)
        {
            int r = player_video_run(s_videos[sel], 1);
            if (r == VID_MENU)
                break;
            if (r == VID_NEXT || (r == VID_FINISHED && sel + 1 < s_count))
            {
                sel = (sel + 1) % s_count;
                continue;
            }
            if (r == VID_PREV)
            {
                sel = (sel + s_count - 1) % s_count;
                continue;
            }
            // Last video finished: START/A plays the list again, B goes back
            if (player_hold_end())
                sel = 0;
            else
                break;
        }
    }
}
