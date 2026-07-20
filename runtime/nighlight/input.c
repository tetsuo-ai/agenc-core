#define _DEFAULT_SOURCE
#define _BSD_SOURCE
#include "nighlight.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <termios.h>
#include <sys/select.h>
#include <errno.h>

static struct termios g_old;
static bool g_raw = false;
static bool g_smoke = false;
static int g_flags = -1;

void input_init(bool smoke) {
    g_smoke = smoke;
    if (smoke) {
        /* keep canonical-ish; read from stdin pipe nonblocking */
        g_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
        if (g_flags >= 0) fcntl(STDIN_FILENO, F_SETFL, g_flags | O_NONBLOCK);
        return;
    }
    if (!isatty(STDIN_FILENO)) {
        g_flags = fcntl(STDIN_FILENO, F_GETFL, 0);
        if (g_flags >= 0) fcntl(STDIN_FILENO, F_SETFL, g_flags | O_NONBLOCK);
        return;
    }
    if (tcgetattr(STDIN_FILENO, &g_old) == 0) {
        struct termios raw = g_old;
        cfmakeraw(&raw);
        raw.c_cc[VMIN] = 0;
        raw.c_cc[VTIME] = 0;
        tcsetattr(STDIN_FILENO, TCSANOW, &raw);
        g_raw = true;
    }
}

void input_shutdown(void) {
    if (g_raw) {
        tcsetattr(STDIN_FILENO, TCSANOW, &g_old);
        g_raw = false;
    }
    if (g_flags >= 0) {
        fcntl(STDIN_FILENO, F_SETFL, g_flags);
        g_flags = -1;
    }
}

static Input map_char(unsigned char c) {
    switch (c) {
        case 'w': case 'W': return IN_UP;
        case 's': case 'S': return IN_DOWN;
        case 'a': case 'A': return IN_LEFT;
        case 'd': case 'D': return IN_RIGHT;
        case 'f': case 'F': return IN_TOGGLE_LIGHT;
        case '.': case ' ': return IN_WAIT;
        case 'q': case 'Q': case 3: /* Ctrl-C */ return IN_QUIT;
        case 'r': case 'R': return IN_RESTART;
        case '\r': case '\n': return IN_START;
        default: return IN_NONE;
    }
}

Input input_poll(Game *g) {
    (void)g;
    unsigned char buf[16];
    ssize_t n = read(STDIN_FILENO, buf, sizeof(buf));
    if (n <= 0) return IN_NONE;

    /* handle ANSI arrows ESC [ A/B/C/D */
    for (ssize_t i = 0; i < n; i++) {
        if (buf[i] == 0x1b && i + 2 < n && buf[i + 1] == '[') {
            unsigned char k = buf[i + 2];
            if (k == 'A') return IN_UP;
            if (k == 'B') return IN_DOWN;
            if (k == 'C') return IN_RIGHT;
            if (k == 'D') return IN_LEFT;
            i += 2;
            continue;
        }
        Input in = map_char(buf[i]);
        if (in != IN_NONE) return in;
    }
    return IN_NONE;
}
