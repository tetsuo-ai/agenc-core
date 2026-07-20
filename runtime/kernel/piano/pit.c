#include "pit.h"
#include "io.h"
#include "vga.h"

/* Track currently playing notes */
static struct {
    uint8_t key;        /* ASCII key for display */
    uint16_t divisor;   /* PIT divisor value */
    int active;         /* Is this note active? */
} active_notes[8];

/* Note mappings from keyboard */
struct {
    uint8_t scancode;
    uint8_t key;
    uint16_t divisor;
    const char *note_name;
} note_map[] = {
    {0x10, 'A', PIT_TO_C4, "C4"},
    {0x12, 'S', PIT_TO_D4, "D4"},
    {0x14, 'D', PIT_TO_E4, "E4"},
    {0x16, 'F', PIT_TO_F4, "F4"},
    {0x18, 'G', PIT_TO_G4, "G4"},
    {0x20, 'H', PIT_TO_A4, "A4"},
    {0x22, 'J', PIT_TO_B4, "B4"},
    {0x24, 'K', PIT_TO_C5, "C5"},
};

static uint8_t find_note_by_key(uint8_t key)
{
    for (int i = 0; i < 8; i++) {
        if (note_map[i].key == key)
            return i;
    }
    return 0xFF;
}

static uint8_t find_note_by_scancode(uint8_t sc)
{
    for (int i = 0; i < 8; i++) {
        if (note_map[i].scancode == sc)
            return i;
    }
    return 0xFF;
}

void pit_keyboard_handler(struct interrupt_frame *frame)
{
    uint8_t sc = inb(0x60); /* Read scancode from keyboard data port */
    uint8_t idx;

    (void)frame;

    if (sc == 0xE0) { /* Extended key, ignore */
        return;
    }

    idx = find_note_by_scancode(sc);

    if (sc & 0x80) { /* Key release */
        sc &= 0x7F;
        idx = find_note_by_scancode(sc);
        if (idx != 0xFF && active_notes[idx].active) {
            /* Stop the note */
            speaker_enable(0);
            active_notes[idx].active = 0;
            active_notes[idx].key = 0;

            /* Redraw keyboard display */
            vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
            vga_set_cursor(2, 0);

            for (int i = 0; i < 8; i++) {
                vga_set_color(VGA_COLOR_LIGHT_CYAN, VGA_COLOR_BLACK);

                if (i == 0) {
                    vga_writeln("   A   S   D   F   G   H   J   K   ");
                    vga_set_cursor(3, i * 4);
                    vga_set_color(VGA_COLOR_YELLOW, VGA_COLOR_BLACK);
                    vga_write(" _ ");
                }
            }
        }
    } else {
        /* Key press */
        if (idx != 0xFF) {
            /* Start the note */
            speaker_enable(1);
            pit_set_divisor(note_map[idx].divisor);
            active_notes[idx].key = note_map[idx].key;
            active_notes[idx].divisor = note_map[idx].divisor;
            active_notes[idx].active = 1;

            /* Show which note is active on the display */
            vga_set_cursor(1, 0);
            vga_set_color(VGA_COLOR_LIGHT_RED, VGA_COLOR_BLACK);
            vga_write(active_notes[idx].key);
            vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
            vga_set_cursor(1, 0);
        }
    }
}

void pit_init(void)
{
    /* Initialize all notes as inactive */
    for (int i = 0; i < 8; i++) {
        active_notes[i].key = 0;
        active_notes[i].divisor = 0;
        active_notes[i].active = 0;
    }

    /* Initialize PIT channel 2 */
    pit_channel2_init();

    /* Initialize the on-screen keyboard display */
    vga_set_cursor(0, 0);
    vga_writeln("Piano App - Keyboard");
    vga_writeln("====================");
    vga_writeln("");
    vga_writeln("   A   S   D   F   G   H   J   K   ");
    vga_writeln("");
    vga_writeln("Press any key...");
}