// Video list shown when the ROM holds more than one video (Mode 3).

#include "common.h"
#include "ui.h"

#define LIST_Y     32
#define ROW_H      14
#define ROWS       7
#define HINT_Y     (SCREEN_H - 12)

// "m:ss" without pulling in the stdio formatter
static void fmt_time(char *buf, u32 secs)
{
    u32 m = secs / 60, s = secs % 60;
    char tmp[8];
    int n = 0;
    do
    {
        tmp[n++] = '0' + m % 10;
        m /= 10;
    } while (m && n < 5);
    while (n)
        *buf++ = tmp[--n];
    *buf++ = ':';
    *buf++ = '0' + s / 10;
    *buf++ = '0' + s % 10;
    *buf = 0;
}

static u32 entry_secs(const VmkEntry *e)
{
    return vbl_to_secs(e->param1 * e->param2);
}

// Cartridge header title (12 chars at 0x080000A0, always mapped)
static void rom_title(char *buf)
{
    const char *t = (const char *)0x080000A0;
    int n = 0;
    for (; n < 12 && t[n]; n++)
        buf[n] = t[n];
    while (n > 0 && buf[n - 1] == ' ')
        n--;
    buf[n] = 0;
}

static void draw_row(const VmkEntry *const *videos, int i, int row, int sel)
{
    int y = LIST_Y + row * ROW_H;
    ui_fill_rect(0, y, SCREEN_W, ROW_H, i == sel ? CLR_ROW_SEL : CLR_BG);

    char name[25];
    int n = 0;
    for (; n < 21 && videos[i]->name[n]; n++)
        name[n] = videos[i]->name[n];
    name[n] = 0;
    ui_text(8, y + 3, name, i == sel ? CLR_TITLE : CLR_TEXT);

    char t[12];
    fmt_time(t, entry_secs(videos[i]));
    ui_text(SCREEN_W - 8 - ui_text_width(t), y + 3, t,
            i == sel ? CLR_TITLE : CLR_TEXT_DIM);
}

static void draw_list(const VmkEntry *const *videos, int count, int top,
                      int sel)
{
    ui_fill_rect(0, LIST_Y, SCREEN_W, ROWS * ROW_H, CLR_BG);
    for (int r = 0; r < ROWS && top + r < count; r++)
        draw_row(videos, top + r, r, sel);

    // Scroll hints
    ui_fill_rect(SCREEN_W - 8, LIST_Y - 8, 8, 8, CLR_BG);
    ui_fill_rect(SCREEN_W - 8, LIST_Y + ROWS * ROW_H, 8, 8, CLR_BG);
    if (top > 0)
        ui_text(SCREEN_W - 8, LIST_Y - 8, "^", CLR_ACCENT);
    if (top + ROWS < count)
        ui_text(SCREEN_W - 8, LIST_Y + ROWS * ROW_H, "v", CLR_ACCENT);
}

int menu_run(const VmkEntry *const *videos, int count, int start)
{
    REG_DISPCNT = DCNT_MODE3 | DCNT_BG2;
    bg2_identity();

    char title[16];
    rom_title(title);
    ui_clear(CLR_BG);
    ui_fill_rect(0, 0, SCREEN_W, 24, CLR_HEADER);
    ui_text_center(8, title[0] ? title : "VIDEOS", CLR_TITLE);
    ui_fill_rect(0, 24, SCREEN_W, 1, CLR_ACCENT);
    ui_text_center(HINT_Y, "A PLAY   L/R PREV/NEXT", CLR_TEXT_DIM);

    int sel = start < count ? start : 0;
    int top = sel - ROWS / 2;
    if (top > count - ROWS)
        top = count - ROWS;
    if (top < 0)
        top = 0;
    draw_list(videos, count, top, sel);

    key_repeat_limits(20, 5);
    while (1)
    {
        VBlankIntrWait();
        key_poll();
        if (key_hit(KEY_A) || key_hit(KEY_START))
            return sel;

        int prev = sel;
        if (key_repeat(KEY_DOWN))
            sel = (sel + 1) % count;
        else if (key_repeat(KEY_UP))
            sel = (sel + count - 1) % count;
        if (sel == prev)
            continue;

        int old_top = top;
        if (sel < top)
            top = sel;
        else if (sel >= top + ROWS)
            top = sel - ROWS + 1;
        if (top != old_top)
            draw_list(videos, count, top, sel);
        else
        {
            draw_row(videos, prev, prev - top, sel);
            draw_row(videos, sel, sel - top, sel);
        }
    }
}
