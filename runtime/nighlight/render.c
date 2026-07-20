#include "nighlight.h"
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define CSI "\x1b["

void term_init(void) {
    fputs(CSI "?25l", stdout);   /* hide cursor */
    fputs(CSI "?1049h", stdout); /* alt screen */
    fputs(CSI "2J", stdout);
    fflush(stdout);
}

void term_restore(void) {
    fputs(CSI "?1049l", stdout);
    fputs(CSI "?25h", stdout);
    fputs(CSI "0m", stdout);
    fflush(stdout);
}

void term_clear(void) {
    fputs(CSI "H" CSI "2J", stdout);
}

static void go(int row, int col) {
    /* 1-based */
    printf(CSI "%d;%dH", row, col);
}

static void color_fg(int r, int g, int b) {
    printf(CSI "38;2;%d;%d;%dm", r, g, b);
}

static void color_bg(int r, int g, int b) {
    printf(CSI "48;2;%d;%d;%dm", r, g, b);
}

static void reset_col(void) { fputs(CSI "0m", stdout); }

static char tile_ch(TileType t) {
    switch (t) {
        case TILE_WALL: return '#';
        case TILE_FLOOR: return '.';
        case TILE_DOOR_LOCKED: return '+';
        case TILE_DOOR_OPEN: return '/';
        case TILE_EXIT_LOCKED: return 'X';
        case TILE_EXIT_OPEN: return 'E';
        default: return '?';
    }
}

void render_title(const Game *g) {
    (void)g;
    term_clear();
    go(4, 10);
    color_fg(180, 40, 40);
    fputs("N I G H L I G H T", stdout);
    reset_col();
    go(6, 8);
    color_fg(140, 140, 150);
    fputs("A pitch-black house. One light. One thing that hunts.", stdout);
    go(9, 10);
    fputs("WASD / arrows  move", stdout);
    go(10, 10);
    fputs("F              toggle flashlight", stdout);
    go(11, 10);
    fputs(".              wait", stdout);
    go(12, 10);
    fputs("R              restart   Q quit", stdout);
    go(15, 10);
    color_fg(220, 200, 120);
    fputs("Press ENTER or SPACE to begin", stdout);
    reset_col();
    go(18, 10);
    color_fg(80, 80, 90);
    fputs("Collect keys. Unlock the exit. Don't get caught.", stdout);
    reset_col();
    fflush(stdout);
}

void render_end(const Game *g, bool win) {
    term_clear();
    if (win) {
        go(4, 14);
        color_fg(80, 200, 120);
        fputs("========================", stdout);
        go(5, 14);
        color_fg(120, 230, 150);
        fputs("     YOU ESCAPED", stdout);
        go(6, 14);
        color_fg(80, 200, 120);
        fputs("========================", stdout);
        go(8, 8);
        reset_col();
        color_fg(180, 180, 190);
        fputs("Dawn never came, but the door did.", stdout);
        go(9, 8);
        fputs("Keys turned. Light held. You made it out.", stdout);
    } else {
        go(4, 14);
        color_fg(140, 30, 30);
        fputs("========================", stdout);
        go(5, 12);
        color_fg(230, 50, 50);
        if (g->lose_reason == LOSE_SANITY)
            fputs("     MIND SHATTERED", stdout);
        else
            fputs("     YOU WERE TAKEN", stdout);
        go(6, 14);
        color_fg(140, 30, 30);
        fputs("========================", stdout);
        go(8, 8);
        reset_col();
        color_fg(160, 100, 100);
        if (g->lose_reason == LOSE_SANITY)
            fputs("The dark got inside. There was no you left.", stdout);
        else
            fputs("The house keeps what it finds in the dark.", stdout);
        go(9, 8);
        if (g->lose_reason == LOSE_SANITY)
            fputs("Stay lit. Stay sane. Or don't come back.", stdout);
        else
            fputs("It was closer than your light could reach.", stdout);
    }
    go(12, 10);
    reset_col();
    color_fg(200, 200, 200);
    printf("Keys %d/%d   Sanity %.0f   Battery %.0f   Ticks %d",
           g->player.keys, g->player.keys_needed,
           g->player.sanity, g->player.battery, g->tick);
    if (g->message[0]) {
        go(13, 10);
        color_fg(180, 150, 120);
        fputs(g->message, stdout);
    }
    go(16, 10);
    color_fg(220, 200, 120);
    fputs("R  restart          Q  quit", stdout);
    reset_col();
    fflush(stdout);
}

void render_frame(const Game *g) {
    const Map *m = &g->map;
    const Player *p = &g->player;

    /* low sanity: shake + occasional full invert flash via bg tint */
    int shake_x = 0;
    int shake_y = 0;
    if (g->shake > 0.5f) {
        shake_x = ((g->tick / 2) % 3) - 1;
        if (g->shake > 1.5f)
            shake_y = ((g->tick / 3) % 3) - 1;
    }

    go(1, 1);
    /* status bar */
    reset_col();
    color_fg(200, 200, 210);
    printf("NIGHLIGHT  BAT:");
    int bbar = (int)(p->battery / 5.0f);
    if (bbar < 0) bbar = 0;
    if (bbar > 20) bbar = 20;
    if (p->battery < 20.0f) color_fg(220, 80, 60);
    else if (p->flashlight_on) color_fg(230, 210, 90);
    else color_fg(100, 100, 110);
    for (int i = 0; i < 20; i++) putchar(i < bbar ? '|' : '.');
    reset_col();
    color_fg(200, 200, 210);
    printf("  SAN:");
    int sbar = (int)(p->sanity / 5.0f);
    if (sbar < 0) sbar = 0;
    if (sbar > 20) sbar = 20;
    if (p->sanity < 15.0f) color_fg(255, 40, 200);
    else if (p->sanity < 30.0f) color_fg(180, 60, 200);
    else if (p->sanity < 50.0f) color_fg(160, 120, 220);
    else color_fg(140, 160, 220);
    for (int i = 0; i < 20; i++) putchar(i < sbar ? '|' : '.');
    reset_col();
    color_fg(200, 200, 210);
    printf("  KEYS:%d/%d  LIGHT:%s  ",
           p->keys, p->keys_needed,
           (p->flashlight_on && p->battery > 0.1f) ? "ON " : "off");
    if (g->stalker.mode == STALK_CHASE) {
        color_fg(255, 60, 60);
        fputs("!HUNTED! ", stdout);
    } else if (g->stalker.mode == STALK_ALERT) {
        color_fg(255, 160, 60);
        fputs("?alert?  ", stdout);
    } else {
        fputs("         ", stdout);
    }
    reset_col();
    /* clear rest of line */
    fputs(CSI "K", stdout);

    int base_row = 2 + shake_y;
    float vig = g->vignette;
    for (int y = 0; y < MAP_H; y++) {
        go(base_row + y, 1 + shake_x);
        for (int x = 0; x < MAP_W; x++) {
            bool vis = m->visible[y][x];
            bool exp = m->explored[y][x];

            /* pickups / entities only if visible */
            char ch = ' ';
            int fr = 0, fg = 0, fb = 0;
            int br = 0, bg = 0, bb = 0;
            bool draw = false;

            /* edge vignette factor from map center */
            float edge = 0.0f;
            if (vig > 0.01f) {
                float nx = (float)x / (float)(MAP_W - 1) - 0.5f;
                float ny = (float)y / (float)(MAP_H - 1) - 0.5f;
                float d = (nx * nx + ny * ny) * 4.0f; /* 0 center .. ~1 corners */
                if (d > 1.0f) d = 1.0f;
                edge = d * vig;
            }

            if (vis) {
                draw = true;
                TileType t = m->tiles[y][x];
                ch = tile_ch(t);
                /* distance falloff from player */
                int md = manh(x, y, p->x, p->y);
                float fall = 1.0f - (float)md / (float)(FOV_RADIUS_MAX + 1);
                if (fall < 0.15f) fall = 0.15f;
                fall *= (0.75f + 0.25f * g->flicker);

                if (t == TILE_WALL) {
                    fr = (int)(40 * fall); fg = (int)(40 * fall); fb = (int)(55 * fall);
                    ch = '#';
                } else if (t == TILE_DOOR_LOCKED) {
                    fr = (int)(160 * fall); fg = (int)(100 * fall); fb = (int)(40 * fall);
                } else if (t == TILE_DOOR_OPEN) {
                    fr = (int)(120 * fall); fg = (int)(90 * fall); fb = (int)(50 * fall);
                } else if (t == TILE_EXIT_LOCKED) {
                    fr = (int)(180 * fall); fg = (int)(50 * fall); fb = (int)(50 * fall);
                } else if (t == TILE_EXIT_OPEN) {
                    fr = (int)(80 * fall); fg = (int)(200 * fall); fb = (int)(100 * fall);
                } else {
                    fr = (int)(30 * fall); fg = (int)(30 * fall); fb = (int)(36 * fall);
                    ch = (md <= 1) ? '.' : (md <= 4 ? '.' : ' ');
                    if (ch == ' ') { fr = 10; fg = 10; fb = 14; ch = '.'; }
                }

                /* sanity haze: purple tint */
                if (p->sanity < 40.0f) {
                    float h = (40.0f - p->sanity) / 40.0f;
                    fr = clampi(fr + (int)(40 * h), 0, 255);
                    fb = clampi(fb + (int)(50 * h), 0, 255);
                    fg = clampi(fg - (int)(20 * h), 0, 255);
                }

                /* low-sanity static: scramble glyphs */
                if (p->sanity < 20.0f && ch != '@' && ch != '&') {
                    unsigned hsh = (unsigned)(x * 73856093u ^ y * 19349663u ^ (unsigned)g->tick * 83492791u);
                    if ((hsh % 100) < (unsigned)((20.0f - p->sanity) * 2.0f)) {
                        const char *glitch = "#*+%:~";
                        ch = glitch[hsh % 6];
                        fr = clampi(fr + 40, 0, 255);
                        fb = clampi(fb + 60, 0, 255);
                    }
                }

                if (g->invert_pulse) {
                    br = fr; bg = fg; bb = fb;
                    fr = 255 - fr; fg = 255 - fg; fb = 255 - fb;
                }
            } else if (exp) {
                draw = true;
                TileType t = m->tiles[y][x];
                ch = tile_ch(t);
                if (t == TILE_WALL) ch = '#';
                else if (t == TILE_FLOOR) ch = ' ';
                fr = 18; fg = 18; fb = 24;
                if (p->sanity < 25.0f) {
                    fr = 24; fg = 12; fb = 28;
                }
            } else {
                draw = true;
                ch = ' ';
                fr = 0; fg = 0; fb = 0;
            }

            /* entities */
            if (vis) {
                for (int i = 0; i < m->key_count; i++) {
                    if (!m->keys[i].taken && m->keys[i].x == x && m->keys[i].y == y) {
                        ch = 'k'; fr = 240; fg = 200; fb = 60;
                    }
                }
                for (int i = 0; i < m->battery_count; i++) {
                    if (!m->batteries[i].taken && m->batteries[i].x == x && m->batteries[i].y == y) {
                        ch = 'b'; fr = 80; fg = 200; fb = 255;
                    }
                }
                if (g->stalker.active && g->stalker.x == x && g->stalker.y == y) {
                    ch = '&';
                    fr = 200; fg = 30; fb = 30;
                    if (g->stalker.mode == STALK_CHASE) { fr = 255; fg = 0; fb = 0; }
                }
                if (p->x == x && p->y == y) {
                    ch = '@';
                    fr = 240; fg = 240; fb = 245;
                    if (p->sanity < 25.0f) {
                        fr = 220; fg = 180; fb = 255;
                    }
                }
            }

            /* apply vignette dimming */
            if (edge > 0.0f) {
                float mul = 1.0f - edge * 0.85f;
                fr = (int)(fr * mul);
                fg = (int)(fg * mul);
                fb = (int)(fb * mul);
                if (edge > 0.55f && !vis) {
                    br = (int)(20 * edge);
                    bg = 0;
                    bb = (int)(28 * edge);
                }
            }

            if (draw) {
                if (br | bg | bb) color_bg(br, bg, bb);
                color_fg(fr, fg, fb);
                putchar(ch);
                if (br | bg | bb) reset_col();
            } else {
                putchar(' ');
            }
        }
        reset_col();
        fputs(CSI "K", stdout);
    }

    /* message line */
    go(2 + MAP_H + 1, 1);
    reset_col();
    if (g->message_ttl > 0 && g->message[0]) {
        color_fg(220, 180, 120);
        fputs(g->message, stdout);
    } else if (p->sanity < 25.0f) {
        color_fg(180, 80, 200);
        fputs("Your thoughts fray at the edges...", stdout);
    }
    fputs(CSI "K", stdout);
    go(2 + MAP_H + 2, 1);
    color_fg(90, 90, 100);
    fputs("WASD move  F light  . wait  R restart  Q quit", stdout);
    fputs(CSI "K", stdout);
    reset_col();
    fflush(stdout);
}
