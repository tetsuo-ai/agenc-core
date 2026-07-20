#include "vga.h"
#include "io.h"
#include "string.h"

static uint16_t *const VGA_BUFFER = (uint16_t *)0xB8000;
static size_t row;
static size_t col;
static uint8_t color;

static inline uint8_t vga_entry_color(uint8_t fg, uint8_t bg)
{
    return (uint8_t)(fg | (bg << 4));
}

static inline uint16_t vga_entry(char c, uint8_t color_byte)
{
    return (uint16_t)c | ((uint16_t)color_byte << 8);
}

static void update_hw_cursor(void)
{
    uint16_t pos = (uint16_t)(row * VGA_WIDTH + col);
    outb(0x3D4, 0x0F);
    outb(0x3D5, (uint8_t)(pos & 0xFF));
    outb(0x3D4, 0x0E);
    outb(0x3D5, (uint8_t)((pos >> 8) & 0xFF));
}

static void scroll(void)
{
    size_t r, c;
    for (r = 1; r < VGA_HEIGHT; r++) {
        for (c = 0; c < VGA_WIDTH; c++) {
            VGA_BUFFER[(r - 1) * VGA_WIDTH + c] =
                VGA_BUFFER[r * VGA_WIDTH + c];
        }
    }
    for (c = 0; c < VGA_WIDTH; c++)
        VGA_BUFFER[(VGA_HEIGHT - 1) * VGA_WIDTH + c] = vga_entry(' ', color);
    row = VGA_HEIGHT - 1;
}

void vga_init(void)
{
    row = 0;
    col = 0;
    color = vga_entry_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
    vga_clear();
}

void vga_clear(void)
{
    size_t i;
    for (i = 0; i < VGA_WIDTH * VGA_HEIGHT; i++)
        VGA_BUFFER[i] = vga_entry(' ', color);
    row = 0;
    col = 0;
    update_hw_cursor();
}

void vga_set_color(uint8_t fg, uint8_t bg)
{
    color = vga_entry_color(fg, bg);
}

void vga_set_cursor(size_t r, size_t c)
{
    if (r >= VGA_HEIGHT)
        r = VGA_HEIGHT - 1;
    if (c >= VGA_WIDTH)
        c = VGA_WIDTH - 1;
    row = r;
    col = c;
    update_hw_cursor();
}

void vga_get_cursor(size_t *r, size_t *c)
{
    if (r)
        *r = row;
    if (c)
        *c = col;
}

void vga_backspace(void)
{
    if (col > 0) {
        col--;
    } else if (row > 0) {
        row--;
        col = VGA_WIDTH - 1;
    } else {
        return;
    }
    VGA_BUFFER[row * VGA_WIDTH + col] = vga_entry(' ', color);
    update_hw_cursor();
}

void vga_putc(char c)
{
    if (c == '\n') {
        col = 0;
        if (++row >= VGA_HEIGHT)
            scroll();
        update_hw_cursor();
        return;
    }
    if (c == '\r') {
        col = 0;
        update_hw_cursor();
        return;
    }
    if (c == '\t') {
        size_t next = (col + 4) & ~(size_t)3;
        while (col < next)
            vga_putc(' ');
        return;
    }
    if (c == '\b') {
        vga_backspace();
        return;
    }

    VGA_BUFFER[row * VGA_WIDTH + col] = vga_entry(c, color);
    if (++col >= VGA_WIDTH) {
        col = 0;
        if (++row >= VGA_HEIGHT)
            scroll();
    }
    update_hw_cursor();
}

void vga_write(const char *s)
{
    while (*s)
        vga_putc(*s++);
}

void vga_writeln(const char *s)
{
    vga_write(s);
    vga_putc('\n');
}

void vga_write_hex(uint64_t value)
{
    static const char hex[] = "0123456789ABCDEF";
    char buf[19];
    int i;
    buf[0] = '0';
    buf[1] = 'x';
    for (i = 0; i < 16; i++) {
        buf[2 + i] = hex[(value >> (60 - i * 4)) & 0xF];
    }
    buf[18] = '\0';
    /* trim leading zeros but keep at least one digit */
    {
        int start = 2;
        while (start < 17 && buf[start] == '0')
            start++;
        if (start == 18)
            start = 17;
        vga_putc('0');
        vga_putc('x');
        vga_write(buf + start);
    }
}

void vga_write_dec(int64_t value)
{
    char buf[21];
    int i = 0;
    int j;
    uint64_t v;

    if (value < 0) {
        vga_putc('-');
        v = (uint64_t)(-(value + 1)) + 1;
    } else {
        v = (uint64_t)value;
    }

    if (v == 0) {
        vga_putc('0');
        return;
    }

    while (v > 0) {
        buf[i++] = (char)('0' + (v % 10));
        v /= 10;
    }
    for (j = i - 1; j >= 0; j--)
        vga_putc(buf[j]);
}
