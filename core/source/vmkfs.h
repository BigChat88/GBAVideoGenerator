#ifndef VMKFS_H
#define VMKFS_H

#include <tonc.h>

// VMK filesystem: appended to the player ROM by the desktop app.
// All offsets are relative to the start of the filesystem header.
//
// Modified from GBA Video Maker by Bytecodes Software: the video-only player
// plays every VMK_TYPE_VIDEO entry as a playlist; the format itself is
// unchanged (version 1).

#define VMK_TYPE_IMAGE 0
#define VMK_TYPE_AUDIO 1
#define VMK_TYPE_VIDEO 2

#define VMK_MAX_ENTRIES 256

// Video stream defaults (used when an entry carries no resolution)
#define VMK_VID_DEF_W      120
#define VMK_VID_DEF_H      80
#define VMK_VID_PAL_BYTES  512

// Audio: signed 8-bit PCM mono. The sample rate is expressed as samples per
// VBlank (spv): rate = spv * 59.7275 Hz, timer reload = 280896 / spv cycles.
// Valid spv values must divide 280896 (cycles per frame) and be 4-aligned:
// 152 (9.1 kHz), 228 (13.6 kHz), 304 (18.2 kHz), 456 (27.2 kHz), 608 (36.3 kHz)
#define VMK_CYCLES_PER_VBL 280896
#define VMK_SND_DEF_SPV    304

typedef struct VmkEntry
{
    u32  type;          // VMK_TYPE_*
    char name[32];      // zero-terminated display name
    u32  offset;        // data offset from FS base (4-aligned)
    u32  size;          // data size in bytes
    u32  param1;        // video: vblanks per frame
    u32  param2;        // video: frame count
    u32  thumb_offset;  // unused by the video-only player
    u32  reserved1;     // video: (width << 16) | height; 0 = 120x80
    u32  reserved2;     // (video audio spv << 16) | flags (VMK_FLAG_*)
} VmkEntry;             // 64 bytes

typedef struct VmkHeader
{
    char magic[8];      // "VMKFS01\0"
    u32  version;       // 1
    u32  count;
    VmkEntry entries[];
} VmkHeader;

// VmkEntry.reserved2 flags
#define VMK_FLAG_COMPRESSED 1   // frames are LZ77-compressed
#define VMK_FLAG_ADPCM      4   // audio is per-VBlank IMA ADPCM blocks

extern u32 g_fs_base;   // filesystem header address (see romio.h)

const VmkHeader *vmk_find(void);

// ROM address (see romio.h) of data at `offset` from the filesystem header
static inline u32 vmk_data(u32 offset)
{
    return g_fs_base + offset;
}

#endif
