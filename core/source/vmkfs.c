#include "vmkfs.h"
#include "romio.h"

// Address of the filesystem header: a pointer in the normal build, a
// physical cartridge offset in the large one (see romio.h)
u32 g_fs_base;

// The magic bytes are stored XOR-encoded so the compiled player binary never
// contains the plain "VMKFS01" string, which would break the ROM scan below.
// volatile stops the compiler from folding the decoded string into .rodata.
static const volatile u8 s_magic_enc[8] = {
    'V' ^ 0xA5, 'M' ^ 0xA5, 'K' ^ 0xA5, 'F' ^ 0xA5,
    'S' ^ 0xA5, '0' ^ 0xA5, '1' ^ 0xA5, 0 ^ 0xA5,
};

static int magic_ok(const u8 *p)
{
    for (int i = 0; i < 8; i++)
        if (p[i] != (u8)(s_magic_enc[i] ^ 0xA5))
            return 0;
    return 1;
}

#ifdef VMK_BANKED

// The header and entry table are copied to RAM once; entry offsets are then
// resolved against the physical filesystem offset
EWRAM_BSS static u32 s_fs_copy[(sizeof(VmkHeader)
                                + VMK_MAX_ENTRIES * sizeof(VmkEntry)) / 4];

const VmkHeader *vmk_find(void)
{
    VmkHeader *fs = (VmkHeader *)s_fs_copy;
    rom_read(VMK_BANKED_FS_PHYS, fs, sizeof(VmkHeader));
    if (!magic_ok((const u8 *)fs->magic) || fs->version != 1
        || fs->count == 0 || fs->count > VMK_MAX_ENTRIES)
        return NULL;
    rom_read(VMK_BANKED_FS_PHYS + sizeof(VmkHeader), fs->entries,
             fs->count * sizeof(VmkEntry));
    g_fs_base = VMK_BANKED_FS_PHYS;
    return fs;
}

#else

const VmkHeader *vmk_find(void)
{
    // The desktop app aligns the filesystem on a 256-byte boundary after the
    // player code, so scan the cart space in 256-byte steps.
    for (u32 addr = 0x08000100; addr < 0x0A000000; addr += 256)
    {
        if (!magic_ok((const u8 *)addr))
            continue;

        const VmkHeader *fs = (const VmkHeader *)addr;
        if (fs->version == 1 && fs->count > 0 && fs->count <= VMK_MAX_ENTRIES)
        {
            g_fs_base = addr;
            return fs;
        }
    }
    return NULL;
}

#endif
