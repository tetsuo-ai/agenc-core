#include "types.h"
#include "gdt.h"
#include "idt.h"
#include "vga.h"
#include "keyboard.h"
#include "shell.h"
#include "io.h"

#define MULTIBOOT2_BOOTLOADER_MAGIC 0x36d76289

void kernel_main(uint32_t magic, uint32_t multiboot_info)
{
    (void)multiboot_info;

    vga_init();
    vga_set_color(VGA_COLOR_LIGHT_CYAN, VGA_COLOR_BLACK);
    vga_writeln("== bare-metal x86_64 kernel ==");
    vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);

    if (magic != MULTIBOOT2_BOOTLOADER_MAGIC) {
        vga_set_color(VGA_COLOR_LIGHT_RED, VGA_COLOR_BLACK);
        vga_write("bad multiboot2 magic: ");
        vga_write_hex(magic);
        vga_writeln("");
        vga_writeln("continuing anyway...");
        vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
    } else {
        vga_writeln("multiboot2: ok");
    }

    vga_write("gdt... ");
    gdt_init();
    vga_writeln("ok");

    vga_write("idt/pic... ");
    idt_init();
    vga_writeln("ok");

    vga_write("keyboard... ");
    keyboard_init();
    vga_writeln("ok");

    sti();
    vga_writeln("interrupts enabled");
    vga_writeln("");

    /* Start piano application */
    piano_main();

    /* piano_main never returns */
    for (;;) {
        cli();
        hlt();
    }
}
