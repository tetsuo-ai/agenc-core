#include "keyboard.h"
#include "idt.h"
#include "io.h"

#define KBD_DATA_PORT   0x60
#define KBD_STATUS_PORT 0x64
#define KBD_IRQ         1
#define KBD_VECTOR      33
#define KBD_BUF_SIZE    256

static volatile char kbd_buf[KBD_BUF_SIZE];
static volatile size_t kbd_head;
static volatile size_t kbd_tail;

static int shift;
static int caps;
static int extended;

/* US QWERTY scancode set 1 -> ASCII (unshifted / shifted). */
static const char scancode_map[128] = {
    0,   27,  '1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', '\b',
    '\t', 'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '[', ']', '\n',
    0,   'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ';', '\'', '`',
    0,   '\\', 'z', 'x', 'c', 'v', 'b', 'n', 'm', ',', '.', '/', 0,
    '*', 0,   ' ', 0,
};

static const char scancode_map_shift[128] = {
    0,   27,  '!', '@', '#', '$', '%', '^', '&', '*', '(', ')', '_', '+', '\b',
    '\t', 'Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P', '{', '}', '\n',
    0,   'A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L', ':', '"', '~',
    0,   '|', 'Z', 'X', 'C', 'V', 'B', 'N', 'M', '<', '>', '?', 0,
    '*', 0,   ' ', 0,
};

static void kbd_push(char c)
{
    size_t next = (kbd_head + 1) % KBD_BUF_SIZE;
    if (next == kbd_tail)
        return; /* drop on overflow */
    kbd_buf[kbd_head] = c;
    kbd_head = next;
}

static char translate(uint8_t sc)
{
    char c;
    int upper;

    if (sc >= 128)
        return 0;

    if (shift)
        c = scancode_map_shift[sc];
    else
        c = scancode_map[sc];

    if (c >= 'a' && c <= 'z') {
        upper = caps ^ shift;
        if (upper)
            c = (char)(c - 'a' + 'A');
    } else if (c >= 'A' && c <= 'Z') {
        upper = caps ^ shift;
        if (!upper)
            c = (char)(c - 'A' + 'a');
    }
    return c;
}

void keyboard_handler(struct interrupt_frame *frame)
{
    uint8_t sc;
    (void)frame;

    sc = inb(KBD_DATA_PORT);

    if (sc == 0xE0) {
        extended = 1;
        return;
    }

    if (extended) {
        extended = 0;
        /* ignore extended keys for now (arrows, etc.) */
        return;
    }

    /* key release */
    if (sc & 0x80) {
        sc &= 0x7F;
        if (sc == 0x2A || sc == 0x36)
            shift = 0;
        return;
    }

    /* key press */
    if (sc == 0x2A || sc == 0x36) {
        shift = 1;
        return;
    }
    if (sc == 0x3A) {
        caps = !caps;
        return;
    }

    {
        char c = translate(sc);
        if (c)
            kbd_push(c);
    }
}

void keyboard_init(void)
{
    kbd_head = 0;
    kbd_tail = 0;
    shift = 0;
    caps = 0;
    extended = 0;

    /* Drain any pending scancodes. */
    while (inb(KBD_STATUS_PORT) & 1)
        (void)inb(KBD_DATA_PORT);

    idt_register_handler(KBD_VECTOR, keyboard_handler);
    irq_clear_mask(KBD_IRQ);
}

int keyboard_getchar(void)
{
    char c;
    if (kbd_head == kbd_tail)
        return -1;
    c = kbd_buf[kbd_tail];
    kbd_tail = (kbd_tail + 1) % KBD_BUF_SIZE;
    return (unsigned char)c;
}

char keyboard_getchar_block(void)
{
    int c;
    for (;;) {
        c = keyboard_getchar();
        if (c >= 0)
            return (char)c;
        __asm__ volatile("hlt");
    }
}
