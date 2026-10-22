# GBA Video Generator - player ROMs
# Modified from GBA Video Maker by Bytecodes Software (see LICENSE-GbaVideo).
# Requires devkitARM + libtonc (https://devkitpro.org). Easiest: ./build.sh
# (runs this Makefile inside the devkitpro/devkitarm Docker image).
#
# Outputs (copied to the desktop app by `make install`):
#   player.gba     cartridge player, for ROMs up to 32 MiB
#   player_mb.gba  same player as a multiboot (EWRAM) image reading the
#                  cartridge through the Matrix mapper, for 32..64 MiB ROMs
#   loader.gba     4 KiB boot loader placed in front of player_mb.gba

DEVKITPRO ?= /opt/devkitpro
DEVKITARM ?= $(DEVKITPRO)/devkitARM

PREFIX  := $(DEVKITARM)/bin/arm-none-eabi-
CC      := $(PREFIX)gcc
AS      := $(PREFIX)as
LD      := $(PREFIX)ld
OBJCOPY := $(PREFIX)objcopy
GBAFIX  := $(DEVKITPRO)/tools/bin/gbafix

BUILD   := build
SRCS    := $(wildcard source/*.c)
HDRS    := $(wildcard source/*.h)
OBJS    := $(patsubst source/%.c,$(BUILD)/cart/%.o,$(SRCS))
OBJS_MB := $(patsubst source/%.c,$(BUILD)/mb/%.o,$(SRCS))

# The desktop app copies these into the final ROM (title is rewritten per
# conversion, so the gbafix titles are just placeholders)
ROM_ASSETS := ../app/resources/rom-assets

ARCH    := -mthumb -mthumb-interwork
CFLAGS  := $(ARCH) -mcpu=arm7tdmi -mtune=arm7tdmi -O2 -Wall -Wextra \
           -fomit-frame-pointer -ffunction-sections -fdata-sections \
           -I$(DEVKITPRO)/libtonc/include
LDFLAGS := $(ARCH) -Wl,--gc-sections -L$(DEVKITPRO)/libtonc/lib
LIBS    := -ltonc

.PHONY: all clean install

all: player.gba player_mb.gba loader.gba

$(BUILD)/cart/%.o: source/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/mb/%.o: source/%.c $(HDRS)
	@mkdir -p $(dir $@)
	$(CC) $(CFLAGS) -DVMK_BANKED -c $< -o $@

player.elf: $(OBJS)
	$(CC) $(LDFLAGS) -specs=gba.specs $(OBJS) $(LIBS) -o $@

player_mb.elf: $(OBJS_MB)
	$(CC) $(LDFLAGS) -specs=gba_mb.specs $(OBJS_MB) $(LIBS) -o $@

player.gba: player.elf
	$(OBJCOPY) -O binary $< $@
	$(GBAFIX) $@ -tGBAVIDEO -cGVID -mGV

player_mb.gba: player_mb.elf
	$(OBJCOPY) -O binary $< $@
	$(GBAFIX) $@ -tGBAVIDEO -cGVID -mGV

# Game code must start with 'M' for mGBA to enable the Matrix mapper
loader.elf: loader/loader.s
	@mkdir -p $(BUILD)
	$(AS) -mcpu=arm7tdmi $< -o $(BUILD)/loader.o
	$(LD) -Ttext=0x08000000 $(BUILD)/loader.o -o $@

loader.gba: loader.elf
	$(OBJCOPY) -O binary $< $@
	$(GBAFIX) $@ -tGBAVIDEO -cMVID -mGV

install: all
	mkdir -p $(ROM_ASSETS)
	cp player.gba player_mb.gba loader.gba $(ROM_ASSETS)/

clean:
	rm -rf $(BUILD) *.elf *.gba
