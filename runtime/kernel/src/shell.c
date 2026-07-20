#include "shell.h"
#include "keyboard.h"
#include "string.h"
#include "vga.h"
#include "io.h"

#define LINE_MAX 128

extern char stack_top[];
extern char _kernel_end[];

static void print_prompt(void)
{
    vga_set_color(VGA_COLOR_LIGHT_GREEN, VGA_COLOR_BLACK);
    vga_write("kernel");
    vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
    vga_write("> ");
}

static void cmd_help(void)
{
    vga_writeln("Built-in commands:");
    vga_writeln("  help      - show this help");
    vga_writeln("  clear     - clear the screen");
    vga_writeln("  echo ...  - print arguments");
    vga_writeln("  info      - show kernel info");
    vga_writeln("  reboot    - triple-fault reboot via keyboard controller");
    vga_writeln("  halt      - stop the CPU");
    vga_writeln("  peek hex  - read a byte at physical address");
}

static void cmd_info(void)
{
    vga_writeln("bare-metal x86_64 kernel");
    vga_write("  mode:      long mode (64-bit)\n");
    vga_write("  stack_top: ");
    vga_write_hex((uint64_t)(uintptr_t)stack_top);
    vga_write("\n  kernel_end:");
    vga_write_hex((uint64_t)(uintptr_t)_kernel_end);
    vga_write("\n  VGA:       80x25 text @ 0xB8000\n");
}

static void cmd_echo(const char *args)
{
    while (*args == ' ')
        args++;
    vga_writeln(args);
}

static uint64_t parse_hex(const char *s, int *ok)
{
    uint64_t v = 0;
    int digits = 0;

    while (*s == ' ')
        s++;
    if (s[0] == '0' && (s[1] == 'x' || s[1] == 'X'))
        s += 2;

    while (*s) {
        char c = *s++;
        uint64_t d;
        if (c >= '0' && c <= '9')
            d = (uint64_t)(c - '0');
        else if (c >= 'a' && c <= 'f')
            d = (uint64_t)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F')
            d = (uint64_t)(c - 'A' + 10);
        else if (c == ' ')
            break;
        else {
            *ok = 0;
            return 0;
        }
        v = (v << 4) | d;
        digits++;
    }
    *ok = digits > 0;
    return v;
}

static void cmd_peek(const char *args)
{
    int ok = 0;
    uint64_t addr = parse_hex(args, &ok);
    if (!ok) {
        vga_writeln("usage: peek <hex-addr>");
        return;
    }
    /* Only allow low 1 GiB identity map. */
    if (addr >= 0x40000000ULL) {
        vga_writeln("address out of identity-mapped range");
        return;
    }
    {
        uint8_t b = *(volatile uint8_t *)(uintptr_t)addr;
        vga_write("*");
        vga_write_hex(addr);
        vga_write(" = ");
        vga_write_hex(b);
        vga_putc('\n');
    }
}

static void cmd_reboot(void)
{
    int i;
    vga_writeln("rebooting...");
    cli();
    /* Wait for keyboard controller input buffer clear, then pulse reset. */
    for (i = 0; i < 100000; i++) {
        if ((inb(0x64) & 0x02) == 0)
            break;
    }
    outb(0x64, 0xFE);
    for (;;)
        hlt();
}

static void cmd_halt(void)
{
    vga_writeln("halted.");
    cli();
    for (;;)
        hlt();
}

static void handle_line(char *line)
{
    char *cmd = line;
    char *args;

    while (*cmd == ' ')
        cmd++;
    if (*cmd == '\0')
        return;

    args = cmd;
    while (*args && *args != ' ')
        args++;
    if (*args) {
        *args = '\0';
        args++;
    }

    if (strcmp(cmd, "help") == 0) {
        cmd_help();
    } else if (strcmp(cmd, "clear") == 0) {
        vga_clear();
    } else if (strcmp(cmd, "echo") == 0) {
        cmd_echo(args);
    } else if (strcmp(cmd, "info") == 0) {
        cmd_info();
    } else if (strcmp(cmd, "reboot") == 0) {
        cmd_reboot();
    } else if (strcmp(cmd, "halt") == 0) {
        cmd_halt();
    } else if (strcmp(cmd, "peek") == 0) {
        cmd_peek(args);
    } else {
        vga_write("unknown command: ");
        vga_writeln(cmd);
        vga_writeln("type 'help' for a list");
    }
}

void shell_run(void)
{
    char line[LINE_MAX];
    size_t len = 0;

    vga_set_color(VGA_COLOR_LIGHT_CYAN, VGA_COLOR_BLACK);
    vga_writeln("type 'help' for commands");
    vga_set_color(VGA_COLOR_LIGHT_GREY, VGA_COLOR_BLACK);
    print_prompt();

    for (;;) {
        char c = keyboard_getchar_block();

        if (c == '\n' || c == '\r') {
            vga_putc('\n');
            line[len] = '\0';
            handle_line(line);
            len = 0;
            print_prompt();
            continue;
        }

        if (c == '\b' || c == 127) {
            if (len > 0) {
                len--;
                vga_backspace();
            }
            continue;
        }

        /* printable ASCII */
        if (c >= 32 && c < 127) {
            if (len + 1 < LINE_MAX) {
                line[len++] = c;
                vga_putc(c);
            }
        }
    }
}
