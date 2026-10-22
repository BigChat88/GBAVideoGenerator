#ifndef COMMON_H
#define COMMON_H

#include <tonc.h>
#include "vmkfs.h"

#define SCREEN_W 240
#define SCREEN_H 160

// Blue theme palette
#define CLR_BG        RGB15( 1,  5, 12)
#define CLR_HEADER    RGB15( 0,  3,  8)
#define CLR_TITLE     RGB15(31, 31, 31)
#define CLR_TEXT      RGB15(26, 28, 31)
#define CLR_TEXT_DIM  RGB15(13, 16, 22)
#define CLR_ROW_SEL   RGB15( 6, 15, 28)
#define CLR_ACCENT    RGB15(14, 22, 31)

extern const VmkHeader *g_fs;
extern volatile u32 g_vbl_count;   // real-time VBlank clock (ISR-driven)

// Why player_video_run() returned
enum
{
    VID_FINISHED,   // reached the end; the last frame stays on screen
    VID_NEXT,       // R: next video (playlists only)
    VID_PREV,       // L: previous video (playlists only)
    VID_MENU,       // B: back to the video list (playlists only)
};

// Plays one video. In a playlist (`playlist` != 0) L/R/B return to the
// caller; for a single video B just restarts it.
int  player_video_run(const VmkEntry *e, int playlist);
// After VID_FINISHED: draws a play icon over the last frame and waits.
// Returns 1 on START/A (play again), 0 on B.
int  player_hold_end(void);

// Video list for ROMs with several videos; returns the chosen index
int  menu_run(const VmkEntry *const *videos, int count, int start);

void sound_track_start(u32 src, u32 samples_per_vblank, int adpcm,
                       u32 total_samples, u32 start_vbl);
void sound_track_tick(void);          // no-op; ring mode is ISR-driven
void sound_vblank(void);              // call from VBlank ISR (ring feed)
void sound_track_pause(void);
void sound_track_resume(void);
void sound_track_stop(void);

// Seek step: ~5 seconds expressed in VBlanks (300 / 59.73)
#define SEEK_VBLANKS 300

// VBlank count -> whole seconds (59.7275 Hz refresh)
static inline u32 vbl_to_secs(u32 vbl)
{
    return vbl * 100 / 5973;
}

// Bring BG2 back to an identity affine matrix (Mode 3 UI screens)
static inline void bg2_identity(void)
{
    REG_BG2PA = 256;
    REG_BG2PB = 0;
    REG_BG2PC = 0;
    REG_BG2PD = 256;
    REG_BG2X = 0;
    REG_BG2Y = 0;
}

#endif
