# Bare-metal x86_64 kernel
#
# Prefers an ELF cross compiler (x86_64-elf-gcc). Falls back to the host
# freestanding toolchain (x86_64-linux-gnu-gcc / gcc) which works on Linux
# amd64 for this freestanding target.

TARGET   ?=
ifneq ($(shell command -v x86_64-elf-gcc 2>/dev/null),)
  TARGET := x86_64-elf-
else ifneq ($(shell command -v x86_64-linux-gnu-gcc 2>/dev/null),)
  TARGET := x86_64-linux-gnu-
endif

CC      := $(TARGET)gcc
LD      := $(TARGET)ld
AS      := $(TARGET)as
OBJCOPY := $(TARGET)objcopy

# If as/ld from TARGET missing, use system binutils.
ifeq ($(shell command -v $(AS) 2>/dev/null),)
  AS := as
endif
ifeq ($(shell command -v $(LD) 2>/dev/null),)
  LD := ld
endif
ifeq ($(shell command -v $(OBJCOPY) 2>/dev/null),)
  OBJCOPY := objcopy
endif

CFLAGS := -std=c11 -ffreestanding -fno-stack-protector -fno-pic -fno-pie \
          -mno-red-zone -mno-mmx -mno-sse -mno-sse2 \
          -Wall -Wextra -O2 -g \
          -Iinclude

ASFLAGS := --64
LDFLAGS := -nostdlib -static -z max-page-size=0x1000 -T linker.ld

BUILD   := build
ISO_DIR := $(BUILD)/isodir

BOOT_SRC := boot/boot.S boot/isr.S piano/piano.S
C_SRC    := src/kernel.c src/gdt.c src/idt.c src/vga.c \
            src/keyboard.c src/shell.c src/string.c piano/pit.c

BOOT_OBJ := $(patsubst %.S,$(BUILD)/%.o,$(BOOT_SRC))
C_OBJ    := $(patsubst %.c,$(BUILD)/%.o,$(C_SRC))
OBJS     := $(BOOT_OBJ) $(C_OBJ)

KERNEL   := $(BUILD)/kernel.elf
ISO      := $(BUILD)/kernel.iso

QEMU     ?= qemu-system-x86_64
QEMUFLAGS := -cdrom $(ISO) -m 128M -serial stdio -no-reboot -no-shutdown

.PHONY: all clean run run-kernel iso dirs

all: $(KERNEL)

dirs:
	@mkdir -p $(BUILD)/boot $(BUILD)/src $(BUILD)/piano $(ISO_DIR)/boot/grub

$(BUILD)/boot/%.o: boot/%.S | dirs
	$(CC) $(CFLAGS) -c $< -o $@

$(BUILD)/src/%.o: src/%.c | dirs
	$(CC) $(CFLAGS) -c $< -o $@

$(KERNEL): $(OBJS) linker.ld
	$(LD) $(LDFLAGS) -o $@ $(OBJS)
	@echo "built $@"

iso: $(ISO)

$(ISO): $(KERNEL) grub.cfg | dirs
	mkdir -p $(ISO_DIR)/boot/grub
	cp $(KERNEL) $(ISO_DIR)/boot/kernel.elf
	cp grub.cfg $(ISO_DIR)/boot/grub/grub.cfg
	grub-mkrescue -o $(ISO) $(ISO_DIR) 2>/dev/null || \
	  grub-mkrescue -o $(ISO) $(ISO_DIR)
	@echo "built $@"

run: $(ISO)
	$(QEMU) $(QEMUFLAGS)

# QEMU -kernel does not load Multiboot2 ELF64; always boot via GRUB ISO.
run-kernel: run

clean:
	rm -rf $(BUILD)

info:
	@echo "CC=$(CC)"
	@echo "LD=$(LD)"
	@echo "AS=$(AS)"
	@echo "KERNEL=$(KERNEL)"
