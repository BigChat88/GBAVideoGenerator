# rom-assets

The GBA player ([core/](../../../core)), compiled **once** with devkitARM +
libtonc. The desktop app never recompiles it: each conversion appends a VMKFS
filesystem (one entry per video) and rewrites the header title and checksum.

- `player.gba` — cartridge player for ROMs up to 32 MiB. The filesystem goes
  right after it, padded to a 256-byte boundary.
- `loader.gba` + `player_mb.gba` — large ROMs (32..64 MiB, mGBA only). The
  ROM is laid out as loader at 0, `player_mb.gba` (a multiboot image) at
  0x2000, filesystem at 0x42000. The loader's game code starts with `M`, which
  makes mGBA enable the GBA Video "Matrix" mapper; it copies the player into
  EWRAM through the mapper's window and jumps to it.

## How they were generated

```
core/build.sh          # docker run devkitpro/devkitarm:latest make install
```

Any change to `core/` does nothing until these files are rebuilt and
committed. Keep `app/src/main/encoder/` in sync with `core/` (entry layout,
`VMK_FLAG_*` bits in `vmkfs.h`, the large-ROM offsets in `romio.h` and
`loader/loader.s`).
