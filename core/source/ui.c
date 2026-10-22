#include "ui.h"

void ui_clear(u16 clr)
{
    memset16(vid_mem, clr, SCREEN_W * SCREEN_H);
}

void ui_fill_rect(int x, int y, int w, int h, u16 clr)
{
    for (int iy = 0; iy < h; iy++)
        memset16(vid_mem + (y + iy) * SCREEN_W + x, clr, w);
}

void ui_frame_rect(int x, int y, int w, int h, u16 clr)
{
    memset16(vid_mem + y * SCREEN_W + x, clr, w);
    memset16(vid_mem + (y + h - 1) * SCREEN_W + x, clr, w);
    for (int iy = 1; iy < h - 1; iy++)
    {
        vid_mem[(y + iy) * SCREEN_W + x] = clr;
        vid_mem[(y + iy) * SCREEN_W + x + w - 1] = clr;
    }
}

static void ui_glyph(int x, int y, char c, u16 clr)
{
    if (c < 32 || c > 126)
        c = '?';
    const u8 *g = (const u8 *)sys8Font.data + (c - 32) * 8;
    u16 *dst = vid_mem + y * SCREEN_W + x;
    for (int iy = 0; iy < 8; iy++)
    {
        u8 row = g[iy];
        for (int ix = 0; ix < 8; ix++)
            if (row & (1 << ix))
                dst[ix] = clr;
        dst += SCREEN_W;
    }
}

void ui_text(int x, int y, const char *str, u16 clr)
{
    while (*str)
    {
        if (x + 8 > SCREEN_W)
            break;
        ui_glyph(x, y, *str++, clr);
        x += 8;
    }
}

int ui_text_width(const char *str)
{
    int n = 0;
    while (str[n])
        n++;
    return n * 8;
}

void ui_text_center(int y, const char *str, u16 clr)
{
    int x = (SCREEN_W - ui_text_width(str)) / 2;
    if (x < 0)
        x = 0;
    ui_text(x, y, str, clr);
}
