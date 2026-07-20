#include "game.h"

#include <stdio.h>
#include <math.h>

/* Tiny 5x7 bitmap font (digits, A-Z, space, colon, and a few symbols). */
static const uint8_t FONT5X7[][7] = {
    /* ' ' */ {0, 0, 0, 0, 0, 0, 0},
    /* 0 */ {0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E},
    /* 1 */ {0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E},
    /* 2 */ {0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F},
    /* 3 */ {0x0E, 0x11, 0x01, 0x06, 0x01, 0x11, 0x0E},
    /* 4 */ {0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02},
    /* 5 */ {0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E},
    /* 6 */ {0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E},
    /* 7 */ {0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08},
    /* 8 */ {0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E},
    /* 9 */ {0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C},
    /* A */ {0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
    /* B */ {0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E},
    /* C */ {0x0E, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0E},
    /* D */ {0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E},
    /* E */ {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x1F},
    /* F */ {0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10},
    /* G */ {0x0E, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0F},
    /* H */ {0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11},
    /* I */ {0x0E, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0E},
    /* J */ {0x01, 0x01, 0x01, 0x01, 0x11, 0x11, 0x0E},
    /* K */ {0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11},
    /* L */ {0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F},
    /* M */ {0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11},
    /* N */ {0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11},
    /* O */ {0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
    /* P */ {0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10},
    /* Q */ {0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D},
    /* R */ {0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11},
    /* S */ {0x0E, 0x11, 0x10, 0x0E, 0x01, 0x11, 0x0E},
    /* T */ {0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04},
    /* U */ {0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E},
    /* V */ {0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04},
    /* W */ {0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11},
    /* X */ {0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11},
    /* Y */ {0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04},
    /* Z */ {0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F},
    /* : */ {0x00, 0x04, 0x00, 0x00, 0x04, 0x00, 0x00},
    /* - */ {0x00, 0x00, 0x00, 0x1F, 0x00, 0x00, 0x00},
    /* ! */ {0x04, 0x04, 0x04, 0x04, 0x04, 0x00, 0x04},
};

static int glyph_index(char ch)
{
    if (ch == ' ') {
        return 0;
    }
    if (ch >= '0' && ch <= '9') {
        return 1 + (ch - '0');
    }
    if (ch >= 'A' && ch <= 'Z') {
        return 11 + (ch - 'A');
    }
    if (ch >= 'a' && ch <= 'z') {
        return 11 + (ch - 'a');
    }
    if (ch == ':') {
        return 37;
    }
    if (ch == '-') {
        return 38;
    }
    if (ch == '!') {
        return 39;
    }
    return 0;
}

static void draw_text(SDL_Renderer *r, int x, int y, const char *text,
                      int scale, uint8_t cr, uint8_t cg, uint8_t cb)
{
    SDL_SetRenderDrawColor(r, cr, cg, cb, 255);
    int cx = x;
    for (const char *p = text; *p; p++) {
        if (*p == '\n') {
            y += 8 * scale;
            cx = x;
            continue;
        }
        const uint8_t *g = FONT5X7[glyph_index(*p)];
        for (int row = 0; row < 7; row++) {
            uint8_t bits = g[row];
            for (int col = 0; col < 5; col++) {
                if (bits & (0x10 >> col)) {
                    SDL_Rect rc = {cx + col * scale, y + row * scale, scale, scale};
                    SDL_RenderFillRect(r, &rc);
                }
            }
        }
        cx += 6 * scale;
    }
}

static void draw_text_centered(SDL_Renderer *r, int y, const char *text,
                               int scale, uint8_t cr, uint8_t cg, uint8_t cb)
{
    int len = 0;
    for (const char *p = text; *p && *p != '\n'; p++) {
        len++;
    }
    int w = len * 6 * scale;
    draw_text(r, (SCREEN_W - w) / 2, y, text, scale, cr, cg, cb);
}

static void draw_stars(Game *g)
{
    /* deterministic pseudo-stars */
    for (int i = 0; i < 80; i++) {
        unsigned seed = (unsigned)i * 1103515245u + 12345u;
        int x = (int)(seed % (unsigned)SCREEN_W);
        int y = (int)((seed >> 8) % (unsigned)SCREEN_H);
        int drift = (int)(g->star_phase * (float)(10 + (i % 5) * 7));
        y = (y + drift) % SCREEN_H;
        if (y < 0) {
            y += SCREEN_H;
        }
        uint8_t a = (uint8_t)(120 + (i * 13) % 135);
        SDL_SetRenderDrawColor(g->renderer, a, a, 255, 255);
        SDL_RenderDrawPoint(g->renderer, x, y);
        if ((i % 7) == 0) {
            SDL_RenderDrawPoint(g->renderer, x + 1, y);
        }
    }
}

static void draw_player(Game *g)
{
    if (!g->player.alive && g->state == STATE_PLAYING) {
        /* blink while respawning */
        if (((int)(g->state_timer * 10.0f) & 1) == 0) {
            return;
        }
    }
    if (!g->player.alive && g->state != STATE_PLAYING) {
        return;
    }

    float x = g->player.x;
    float y = g->player.y;
    SDL_SetRenderDrawColor(g->renderer, 40, 220, 120, 255);

    /* body */
    SDL_Rect body = {(int)x + 4, (int)y + 8, PLAYER_W - 8, PLAYER_H - 8};
    SDL_RenderFillRect(g->renderer, &body);
    /* cabin */
    SDL_Rect cabin = {(int)x + 12, (int)y + 4, PLAYER_W - 24, 8};
    SDL_RenderFillRect(g->renderer, &cabin);
    /* cannon */
    SDL_Rect cannon = {(int)x + PLAYER_W / 2 - 2, (int)y, 4, 8};
    SDL_RenderFillRect(g->renderer, &cannon);
    /* wings */
    SDL_Rect wingL = {(int)x, (int)y + 12, 8, 6};
    SDL_Rect wingR = {(int)x + PLAYER_W - 8, (int)y + 12, 8, 6};
    SDL_RenderFillRect(g->renderer, &wingL);
    SDL_RenderFillRect(g->renderer, &wingR);
}

static void draw_enemy_sprite(SDL_Renderer *r, Enemy *e)
{
    int x = (int)e->x;
    int y = (int)e->y;
    int f = e->anim_frame;

    uint8_t cr = 255, cg = 80, cb = 80;
    if (e->type == ENEMY_CRAB) {
        cr = 80;
        cg = 220;
        cb = 255;
    } else if (e->type == ENEMY_OCTOPUS) {
        cr = 255;
        cg = 200;
        cb = 60;
    }
    SDL_SetRenderDrawColor(r, cr, cg, cb, 255);

    /* simple pixel-art body built from rects */
    SDL_Rect body = {x + 4, y + 6, ENEMY_W - 8, ENEMY_H - 10};
    SDL_RenderFillRect(r, &body);

    /* head bump */
    SDL_Rect head = {x + 8, y + 2, ENEMY_W - 16, 6};
    SDL_RenderFillRect(r, &head);

    /* eyes */
    SDL_SetRenderDrawColor(r, 10, 10, 20, 255);
    int eye_y = y + 8;
    SDL_Rect eyeL = {x + 8, eye_y, 4, 4};
    SDL_Rect eyeR = {x + ENEMY_W - 12, eye_y, 4, 4};
    SDL_RenderFillRect(r, &eyeL);
    SDL_RenderFillRect(r, &eyeR);

    /* legs - alternate animation */
    SDL_SetRenderDrawColor(r, cr, cg, cb, 255);
    int leg_y = y + ENEMY_H - 6;
    if (f == 0) {
        SDL_Rect l1 = {x + 2, leg_y, 5, 5};
        SDL_Rect l2 = {x + 11, leg_y + 1, 5, 4};
        SDL_Rect l3 = {x + ENEMY_W - 16, leg_y + 1, 5, 4};
        SDL_Rect l4 = {x + ENEMY_W - 7, leg_y, 5, 5};
        SDL_RenderFillRect(r, &l1);
        SDL_RenderFillRect(r, &l2);
        SDL_RenderFillRect(r, &l3);
        SDL_RenderFillRect(r, &l4);
    } else {
        SDL_Rect l1 = {x + 4, leg_y + 1, 5, 4};
        SDL_Rect l2 = {x + 10, leg_y, 5, 5};
        SDL_Rect l3 = {x + ENEMY_W - 15, leg_y, 5, 5};
        SDL_Rect l4 = {x + ENEMY_W - 9, leg_y + 1, 5, 4};
        SDL_RenderFillRect(r, &l1);
        SDL_RenderFillRect(r, &l2);
        SDL_RenderFillRect(r, &l3);
        SDL_RenderFillRect(r, &l4);
    }

    /* claws for squid */
    if (e->type == ENEMY_SQUID) {
        SDL_Rect c1 = {x, y + 10, 4, 3};
        SDL_Rect c2 = {x + ENEMY_W - 4, y + 10, 4, 3};
        SDL_RenderFillRect(r, &c1);
        SDL_RenderFillRect(r, &c2);
    }
}

static void draw_enemies(Game *g)
{
    for (int r = 0; r < ENEMY_ROWS; r++) {
        for (int c = 0; c < ENEMY_COLS; c++) {
            if (g->enemies[r][c].alive) {
                draw_enemy_sprite(g->renderer, &g->enemies[r][c]);
            }
        }
    }
}

static void draw_ufo(Game *g)
{
    if (!g->ufo.active) {
        return;
    }
    int x = (int)g->ufo.x;
    int y = (int)g->ufo.y;
    SDL_SetRenderDrawColor(g->renderer, 255, 60, 180, 255);
    SDL_Rect body = {x + 4, y + 6, UFO_W - 8, UFO_H - 8};
    SDL_RenderFillRect(g->renderer, &body);
    SDL_Rect dome = {x + 10, y + 2, UFO_W - 20, 8};
    SDL_RenderFillRect(g->renderer, &dome);
    SDL_SetRenderDrawColor(g->renderer, 255, 220, 80, 255);
    for (int i = 0; i < 4; i++) {
        SDL_Rect light = {x + 8 + i * 8, y + UFO_H - 6, 4, 3};
        SDL_RenderFillRect(g->renderer, &light);
    }
}

static void draw_bullets(Game *g)
{
    SDL_SetRenderDrawColor(g->renderer, 240, 240, 120, 255);
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++) {
        Bullet *b = &g->player_bullets[i];
        if (!b->active) {
            continue;
        }
        SDL_Rect rc = {(int)b->x, (int)b->y, BULLET_W, BULLET_H};
        SDL_RenderFillRect(g->renderer, &rc);
    }
    SDL_SetRenderDrawColor(g->renderer, 255, 100, 100, 255);
    for (int i = 0; i < MAX_ENEMY_BULLETS; i++) {
        Bullet *b = &g->enemy_bullets[i];
        if (!b->active) {
            continue;
        }
        /* zig-zag look */
        SDL_Rect rc = {(int)b->x, (int)b->y, BULLET_W, BULLET_H};
        SDL_RenderFillRect(g->renderer, &rc);
    }
}

static void draw_shields(Game *g)
{
    int rows = SHIELD_H / SHIELD_BLOCK;
    int cols = SHIELD_W / SHIELD_BLOCK;
    for (int i = 0; i < MAX_SHIELDS; i++) {
        Shield *s = &g->shields[i];
        if (!s->active) {
            continue;
        }
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                if (!s->blocks[r * cols + c]) {
                    continue;
                }
                /* green bunker blocks with slight variation */
                uint8_t shade = (uint8_t)(140 + ((r + c) % 3) * 20);
                SDL_SetRenderDrawColor(g->renderer, 40, shade, 70, 255);
                SDL_Rect rc = {
                    (int)s->x + c * SHIELD_BLOCK,
                    (int)s->y + r * SHIELD_BLOCK,
                    SHIELD_BLOCK,
                    SHIELD_BLOCK};
                SDL_RenderFillRect(g->renderer, &rc);
            }
        }
    }
}

static void draw_hud(Game *g)
{
    char buf[64];
    snprintf(buf, sizeof(buf), "SCORE %05d", g->score);
    draw_text(g->renderer, 16, 12, buf, 2, 220, 220, 220);

    snprintf(buf, sizeof(buf), "HI %05d", g->high_score);
    draw_text(g->renderer, SCREEN_W / 2 - 60, 12, buf, 2, 180, 180, 100);

    snprintf(buf, sizeof(buf), "WAVE %d", g->wave);
    draw_text(g->renderer, SCREEN_W - 140, 12, buf, 2, 180, 220, 255);

    /* lives as mini ships */
    draw_text(g->renderer, 16, SCREEN_H - 28, "LIVES", 1, 160, 160, 160);
    for (int i = 0; i < g->player.lives; i++) {
        int x = 60 + i * 28;
        int y = SCREEN_H - 30;
        SDL_SetRenderDrawColor(g->renderer, 40, 220, 120, 255);
        SDL_Rect body = {x, y + 6, 18, 8};
        SDL_Rect cannon = {x + 7, y, 4, 8};
        SDL_RenderFillRect(g->renderer, &body);
        SDL_RenderFillRect(g->renderer, &cannon);
    }
}

static void draw_overlay_center(Game *g, const char *title, const char *sub)
{
    /* dim */
    SDL_SetRenderDrawColor(g->renderer, 0, 0, 0, 160);
    SDL_Rect full = {0, 0, SCREEN_W, SCREEN_H};
    SDL_RenderFillRect(g->renderer, &full);

    draw_text_centered(g->renderer, SCREEN_H / 2 - 40, title, 3, 255, 255, 255);
    if (sub && sub[0]) {
        draw_text_centered(g->renderer, SCREEN_H / 2 + 10, sub, 2, 180, 220, 180);
    }
}

void game_render(Game *g)
{
    SDL_SetRenderDrawColor(g->renderer, 8, 10, 24, 255);
    SDL_RenderClear(g->renderer);

    draw_stars(g);

    if (g->state != STATE_MENU) {
        draw_shields(g);
        draw_enemies(g);
        draw_ufo(g);
        draw_bullets(g);
        draw_player(g);
        particles_render(g);
        draw_hud(g);
    } else {
        /* menu preview formation */
        draw_enemies(g);
        particles_render(g);
        draw_text_centered(g->renderer, 120, "SPACE INVADERS", 4, 80, 255, 140);
        draw_text_centered(g->renderer, 200, "SDL2 RETRO EDITION", 2, 160, 200, 255);
        draw_text_centered(g->renderer, 300, "PRESS ENTER TO START", 2, 255, 255, 120);
        draw_text_centered(g->renderer, 360, "ARROWS/AD MOVE  SPACE FIRE  P PAUSE", 1, 160, 160, 160);
        draw_text_centered(g->renderer, 400, "ESC QUIT", 1, 120, 120, 120);
        char buf[64];
        snprintf(buf, sizeof(buf), "HIGH SCORE %05d", g->high_score);
        draw_text_centered(g->renderer, 480, buf, 2, 200, 180, 80);
    }

    if (g->state == STATE_PAUSED) {
        draw_overlay_center(g, "PAUSED", "PRESS P TO RESUME");
    } else if (g->state == STATE_GAME_OVER) {
        char sub[64];
        snprintf(sub, sizeof(sub), "SCORE %05d  -  ENTER TO RETRY", g->score);
        draw_overlay_center(g, "GAME OVER", sub);
    } else if (g->state == STATE_WAVE_CLEAR) {
        char title[32];
        snprintf(title, sizeof(title), "WAVE %d CLEAR", g->wave);
        draw_overlay_center(g, title, "GET READY");
    }

    SDL_RenderPresent(g->renderer);
}
