#ifndef UI_H
#define UI_H

#include "common.h"

void ui_clear(u16 clr);
void ui_fill_rect(int x, int y, int w, int h, u16 clr);
void ui_frame_rect(int x, int y, int w, int h, u16 clr);   // 1px outline
void ui_text(int x, int y, const char *str, u16 clr);
void ui_text_center(int y, const char *str, u16 clr);      // centered on 240px
int  ui_text_width(const char *str);

#endif
