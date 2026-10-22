@ Boot loader for large (32..64 MiB) ROMs, mGBA only.
@
@ mGBA treats a ROM over 32 MiB whose game code starts with 'M' as a
@ Matrix-mapped GBA Video cart: only virtual 0x0000-0x1FFF is ever visible,
@ and 0x1000-0x1FFF is a window that physical 512-byte blocks are copied
@ into through the registers at 0x08800180. This loader (which must fit in
@ the first 4 KiB) copies the 256 KiB player image stored at physical
@ 0x2000 into EWRAM through that window and jumps to it. The player is a
@ multiboot build (gba_mb.specs), so its own crt0 sets everything else up.

	.section .text
	.arm
	.global _start

_start:
	b	loader

	@ Cartridge header, filled in by gbafix (and the desktop app's title)
	.space	0xBC

loader:
	ldr	r0, =0x04000204		@ REG_WAITCNT: 3/1 waitstates + prefetch
	ldr	r1, =0x4317
	strh	r1, [r0]

	ldr	r4, =0x00002000		@ physical source: player image
	ldr	r5, =0x02000000		@ EWRAM destination
	ldr	r6, =0x02040000		@ end of EWRAM
	ldr	r7, =0x08800180		@ Matrix command block
	ldr	r8, =0x08001000		@ 4 KiB window (virtual 0x1000)

map_chunk:
	str	r4, [r7, #4]		@ physical address
	mov	r0, #0x1000
	str	r0, [r7, #8]		@ virtual address
	mov	r0, #8
	str	r0, [r7, #12]		@ 8 blocks of 512 bytes
	mov	r0, #0x11
	str	r0, [r7]		@ commit the mapping

	mov	r0, r8
	add	r1, r0, #0x1000
copy_chunk:
	ldmia	r0!, {r2, r3, r9, r10}
	stmia	r5!, {r2, r3, r9, r10}
	cmp	r0, r1
	blt	copy_chunk

	add	r4, r4, #0x1000
	cmp	r5, r6
	blt	map_chunk

	ldr	r0, =0x02000000
	bx	r0

	.pool
