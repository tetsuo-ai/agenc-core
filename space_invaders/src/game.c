#include "game.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <time.h>

/* ---------- helpers ---------- */

static float clampf(float v, float lo, float hi)
{
    if (v < lo) {
        return lo;
    }
    if (v > hi) {
        return hi;
    }
    return v;
}

static bool rects_overlap(float ax, float ay, float aw, float ah,
                          float bx, float by, float bw, float bh)
{
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

static int enemy_points(EnemyType t)
{
    switch (t) {
    case ENEMY_SQUID:
        return 30;
    case ENEMY_CRAB:
        return 20;
    default:
        return 10;
    }
}

static EnemyType enemy_type_for_row(int row)
{
    if (row == 0) {
        return ENEMY_SQUID;
    }
    if (row <= 2) {
        return ENEMY_CRAB;
    }
    return ENEMY_OCTOPUS;
}

static float formation_origin_x(void)
{
    float total_w = ENEMY_COLS * ENEMY_W + (ENEMY_COLS - 1) * ENEMY_H_PAD;
    return (SCREEN_W - total_w) * 0.5f;
}

/* ---------- shields ---------- */

static void shields_init(Game *g)
{
    const float gap = (float)SCREEN_W / (float)(MAX_SHIELDS + 1);
    for (int i = 0; i < MAX_SHIELDS; i++) {
        Shield *s = &g->shields[i];
        s->x = gap * (float)(i + 1) - SHIELD_W * 0.5f;
        s->y = (float)SCREEN_H - 140.0f;
        s->active = true;
        int n = (SHIELD_H / SHIELD_BLOCK) * (SHIELD_W / SHIELD_BLOCK);
        for (int b = 0; b < n; b++) {
            s->blocks[b] = true;
        }
        /* carve a simple arch / bunker silhouette */
        int rows = SHIELD_H / SHIELD_BLOCK;
        int cols = SHIELD_W / SHIELD_BLOCK;
        for (int r = 0; r < rows; r++) {
            for (int c = 0; c < cols; c++) {
                int idx = r * cols + c;
                /* top corners rounded off */
                if (r == 0 && (c < 1 || c >= cols - 1)) {
                    s->blocks[idx] = false;
                }
                /* bottom mouth */
                if (r >= rows - 2 && c >= cols / 2 - 2 && c <= cols / 2 + 1) {
                    s->blocks[idx] = false;
                }
            }
        }
    }
}

static bool shield_hit(Shield *s, float bx, float by, float bw, float bh)
{
    if (!s->active) {
        return false;
    }
    if (!rects_overlap(s->x, s->y, SHIELD_W, SHIELD_H, bx, by, bw, bh)) {
        return false;
    }

    int rows = SHIELD_H / SHIELD_BLOCK;
    int cols = SHIELD_W / SHIELD_BLOCK;
    bool any = false;
    bool hit = false;

    for (int r = 0; r < rows; r++) {
        for (int c = 0; c < cols; c++) {
            int idx = r * cols + c;
            if (!s->blocks[idx]) {
                continue;
            }
            any = true;
            float px = s->x + (float)(c * SHIELD_BLOCK);
            float py = s->y + (float)(r * SHIELD_BLOCK);
            if (rects_overlap(px, py, SHIELD_BLOCK, SHIELD_BLOCK, bx, by, bw, bh)) {
                s->blocks[idx] = false;
                /* damage neighbors a bit */
                for (int dr = -1; dr <= 1; dr++) {
                    for (int dc = -1; dc <= 1; dc++) {
                        int nr = r + dr;
                        int nc = c + dc;
                        if (nr < 0 || nc < 0 || nr >= rows || nc >= cols) {
                            continue;
                        }
                        if ((dr != 0 || dc != 0) && (rand() % 3) == 0) {
                            s->blocks[nr * cols + nc] = false;
                        }
                    }
                }
                hit = true;
            }
        }
    }
    if (!any) {
        s->active = false;
    }
    return hit;
}

/* ---------- bullets ---------- */

static void clear_bullets(Game *g)
{
    memset(g->player_bullets, 0, sizeof(g->player_bullets));
    memset(g->enemy_bullets, 0, sizeof(g->enemy_bullets));
}

static bool spawn_player_bullet(Game *g)
{
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++) {
        Bullet *b = &g->player_bullets[i];
        if (b->active) {
            continue;
        }
        b->x = g->player.x + PLAYER_W * 0.5f - BULLET_W * 0.5f;
        b->y = g->player.y - BULLET_H;
        b->vy = -PLAYER_BULLET_SPEED;
        b->active = true;
        b->from_player = true;
        audio_beep(g, 880.0f, 0.05f, 0.25f);
        return true;
    }
    return false;
}

static bool spawn_enemy_bullet(Game *g, float x, float y)
{
    for (int i = 0; i < MAX_ENEMY_BULLETS; i++) {
        Bullet *b = &g->enemy_bullets[i];
        if (b->active) {
            continue;
        }
        b->x = x - BULLET_W * 0.5f;
        b->y = y;
        b->vy = ENEMY_BULLET_SPEED + (float)g->wave * 8.0f;
        b->active = true;
        b->from_player = false;
        return true;
    }
    return false;
}

/* ---------- wave / reset ---------- */

void game_spawn_wave(Game *g)
{
    float ox = formation_origin_x();
    g->enemy_alive = 0;
    g->enemy_dir = 1;
    g->enemy_anim_tick = 0;
    g->enemy_step_timer = 0.0f;
    g->enemy_step_interval = clampf(0.55f - (float)(g->wave - 1) * 0.04f, 0.12f, 0.55f);
    g->enemy_shoot_timer = 1.0f;
    g->ufo.active = false;
    g->ufo_spawn_timer = UFO_MIN_INTERVAL +
                         ((float)rand() / (float)RAND_MAX) * (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);

    for (int r = 0; r < ENEMY_ROWS; r++) {
        for (int c = 0; c < ENEMY_COLS; c++) {
            Enemy *e = &g->enemies[r][c];
            e->type = enemy_type_for_row(r);
            e->alive = true;
            e->anim_frame = 0;
            e->x = ox + (float)c * (ENEMY_W + ENEMY_H_PAD);
            e->y = ENEMY_START_Y + (float)r * (ENEMY_H + ENEMY_V_PAD) +
                   (float)(g->wave - 1) * 6.0f;
            g->enemy_alive++;
        }
    }
    clear_bullets(g);
}

void game_reset_run(Game *g, bool full_reset)
{
    if (full_reset) {
        g->score = 0;
        g->wave = 1;
        g->player.lives = PLAYER_MAX_LIVES;
    }

    g->player.x = (SCREEN_W - PLAYER_W) * 0.5f;
    g->player.y = (float)SCREEN_H - 60.0f;
    g->player.cooldown = 0.0f;
    g->player.alive = true;
    g->player.moving_left = false;
    g->player.moving_right = false;
    g->player.want_shoot = false;

    memset(g->particles, 0, sizeof(g->particles));
    shields_init(g);
    game_spawn_wave(g);
    g->state_timer = 0.0f;
}

/* ---------- init / shutdown / run ---------- */

bool game_init(Game *g)
{
    memset(g, 0, sizeof(*g));
    g->running = true;
    g->state = STATE_MENU;
    g->high_score = 0;
    g->wave = 1;

    if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO | SDL_INIT_TIMER) != 0) {
        fprintf(stderr, "SDL_Init failed: %s\n", SDL_GetError());
        return false;
    }
    g->sdl_ready = true;

    g->window = SDL_CreateWindow(
        "Space Invaders",
        SDL_WINDOWPOS_CENTERED,
        SDL_WINDOWPOS_CENTERED,
        SCREEN_W,
        SCREEN_H,
        SDL_WINDOW_SHOWN);
    if (!g->window) {
        fprintf(stderr, "SDL_CreateWindow failed: %s\n", SDL_GetError());
        return false;
    }

    g->renderer = SDL_CreateRenderer(
        g->window, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
    if (!g->renderer) {
        g->renderer = SDL_CreateRenderer(g->window, -1, SDL_RENDERER_SOFTWARE);
    }
    if (!g->renderer) {
        fprintf(stderr, "SDL_CreateRenderer failed: %s\n", SDL_GetError());
        return false;
    }

    SDL_SetRenderDrawBlendMode(g->renderer, SDL_BLENDMODE_BLEND);
    srand((unsigned)time(NULL));
    audio_init(g);
    game_reset_run(g, true);
    g->state = STATE_MENU;
    return true;
}

void game_shutdown(Game *g)
{
    audio_shutdown(g);
    if (g->renderer) {
        SDL_DestroyRenderer(g->renderer);
        g->renderer = NULL;
    }
    if (g->window) {
        SDL_DestroyWindow(g->window);
        g->window = NULL;
    }
    if (g->sdl_ready) {
        SDL_Quit();
        g->sdl_ready = false;
    }
}

void game_handle_event(Game *g, const SDL_Event *e)
{
    if (e->type == SDL_QUIT) {
        g->running = false;
        return;
    }

    if (e->type == SDL_KEYDOWN && e->key.repeat == 0) {
        SDL_Keycode k = e->key.keysym.sym;
        if (k == SDLK_ESCAPE) {
            g->running = false;
            return;
        }

        switch (g->state) {
        case STATE_MENU:
            if (k == SDLK_RETURN || k == SDLK_SPACE) {
                game_reset_run(g, true);
                g->state = STATE_PLAYING;
                audio_beep(g, 440.0f, 0.08f, 0.3f);
            }
            break;
        case STATE_PLAYING:
            if (k == SDLK_p) {
                g->state = STATE_PAUSED;
            } else if (k == SDLK_LEFT || k == SDLK_a) {
                g->player.moving_left = true;
            } else if (k == SDLK_RIGHT || k == SDLK_d) {
                g->player.moving_right = true;
            } else if (k == SDLK_SPACE) {
                g->player.want_shoot = true;
            }
            break;
        case STATE_PAUSED:
            if (k == SDLK_p || k == SDLK_RETURN) {
                g->state = STATE_PLAYING;
            }
            break;
        case STATE_GAME_OVER:
            if (k == SDLK_RETURN || k == SDLK_SPACE) {
                game_reset_run(g, true);
                g->state = STATE_PLAYING;
                audio_beep(g, 520.0f, 0.08f, 0.3f);
            }
            break;
        case STATE_WAVE_CLEAR:
            break;
        }
    }

    if (e->type == SDL_KEYUP) {
        SDL_Keycode k = e->key.keysym.sym;
        if (k == SDLK_LEFT || k == SDLK_a) {
            g->player.moving_left = false;
        } else if (k == SDLK_RIGHT || k == SDLK_d) {
            g->player.moving_right = false;
        } else if (k == SDLK_SPACE) {
            g->player.want_shoot = false;
        }
    }
}

/* ---------- gameplay update ---------- */

static void kill_player(Game *g)
{
    if (!g->player.alive) {
        return;
    }
    particles_burst(g, g->player.x + PLAYER_W * 0.5f,
                    g->player.y + PLAYER_H * 0.5f, 40, 80, 220, 255);
    audio_beep(g, 120.0f, 0.25f, 0.45f);
    g->player.lives -= 1;
    g->player.alive = false;
    clear_bullets(g);
    g->state_timer = 1.2f;

    if (g->player.lives <= 0) {
        if (g->score > g->high_score) {
            g->high_score = g->score;
        }
        g->state = STATE_GAME_OVER;
        g->state_timer = 0.0f;
    }
}

static void update_player(Game *g, float dt)
{
    if (!g->player.alive) {
        g->state_timer -= dt;
        if (g->state_timer <= 0.0f && g->state == STATE_PLAYING) {
            g->player.alive = true;
            g->player.x = (SCREEN_W - PLAYER_W) * 0.5f;
            g->player.cooldown = 0.4f;
        }
        return;
    }

    float dx = 0.0f;
    if (g->player.moving_left) {
        dx -= 1.0f;
    }
    if (g->player.moving_right) {
        dx += 1.0f;
    }
    g->player.x += dx * PLAYER_SPEED * dt;
    g->player.x = clampf(g->player.x, 8.0f, (float)SCREEN_W - PLAYER_W - 8.0f);

    if (g->player.cooldown > 0.0f) {
        g->player.cooldown -= dt;
    }
    if (g->player.want_shoot && g->player.cooldown <= 0.0f) {
        if (spawn_player_bullet(g)) {
            g->player.cooldown = PLAYER_COOLDOWN;
        }
    }
}

static void bounds_of_alive_enemies(Game *g, float *min_x, float *max_x, float *max_y)
{
    *min_x = (float)SCREEN_W;
    *max_x = 0.0f;
    *max_y = 0.0f;
    for (int r = 0; r < ENEMY_ROWS; r++) {
        for (int c = 0; c < ENEMY_COLS; c++) {
            Enemy *e = &g->enemies[r][c];
            if (!e->alive) {
                continue;
            }
            if (e->x < *min_x) {
                *min_x = e->x;
            }
            if (e->x + ENEMY_W > *max_x) {
                *max_x = e->x + ENEMY_W;
            }
            if (e->y + ENEMY_H > *max_y) {
                *max_y = e->y + ENEMY_H;
            }
        }
    }
}

static void step_enemies(Game *g)
{
    float min_x, max_x, max_y;
    bounds_of_alive_enemies(g, &min_x, &max_x, &max_y);
    if (g->enemy_alive <= 0) {
        return;
    }

    float step_x = 10.0f * (float)g->enemy_dir;
    bool drop = false;
    if (g->enemy_dir > 0 && max_x + step_x > (float)SCREEN_W - 12.0f) {
        drop = true;
    } else if (g->enemy_dir < 0 && min_x + step_x < 12.0f) {
        drop = true;
    }

    if (drop) {
        g->enemy_dir = -g->enemy_dir;
        for (int r = 0; r < ENEMY_ROWS; r++) {
            for (int c = 0; c < ENEMY_COLS; c++) {
                Enemy *e = &g->enemies[r][c];
                if (e->alive) {
                    e->y += ENEMY_DROP;
                }
            }
        }
        g->enemy_step_interval = clampf(g->enemy_step_interval * 0.92f, 0.08f, 1.0f);
    } else {
        for (int r = 0; r < ENEMY_ROWS; r++) {
            for (int c = 0; c < ENEMY_COLS; c++) {
                Enemy *e = &g->enemies[r][c];
                if (e->alive) {
                    e->x += step_x;
                }
            }
        }
    }

    g->enemy_anim_tick++;
    for (int r = 0; r < ENEMY_ROWS; r++) {
        for (int c = 0; c < ENEMY_COLS; c++) {
            if (g->enemies[r][c].alive) {
                g->enemies[r][c].anim_frame = g->enemy_anim_tick & 1;
            }
        }
    }

    /* marching beep */
    float march = 180.0f + (float)(g->enemy_anim_tick % 4) * 40.0f;
    audio_beep(g, march, 0.04f, 0.12f);

    bounds_of_alive_enemies(g, &min_x, &max_x, &max_y);
    if (max_y >= g->player.y) {
        kill_player(g);
        if (g->state != STATE_GAME_OVER) {
            g->state = STATE_GAME_OVER;
            if (g->score > g->high_score) {
                g->high_score = g->score;
            }
        }
    }
}

static void enemy_try_shoot(Game *g)
{
    if (g->enemy_alive <= 0) {
        return;
    }
    /* pick a random column that has a living bottom-most alien */
    int cols[ENEMY_COLS];
    int n = 0;
    for (int c = 0; c < ENEMY_COLS; c++) {
        for (int r = ENEMY_ROWS - 1; r >= 0; r--) {
            if (g->enemies[r][c].alive) {
                cols[n++] = c;
                break;
            }
        }
    }
    if (n == 0) {
        return;
    }
    int c = cols[rand() % n];
    for (int r = ENEMY_ROWS - 1; r >= 0; r--) {
        Enemy *e = &g->enemies[r][c];
        if (e->alive) {
            spawn_enemy_bullet(g, e->x + ENEMY_W * 0.5f, e->y + ENEMY_H);
            break;
        }
    }
}

static void update_enemies(Game *g, float dt)
{
    if (g->enemy_alive <= 0) {
        return;
    }

    /* speed scales with fewer aliens */
    float alive_f = (float)g->enemy_alive / (float)(ENEMY_ROWS * ENEMY_COLS);
    float base = clampf(0.55f - (float)(g->wave - 1) * 0.04f, 0.12f, 0.55f);
    g->enemy_step_interval = clampf(base * (0.35f + 0.65f * alive_f), 0.07f, 0.55f);

    g->enemy_step_timer -= dt;
    if (g->enemy_step_timer <= 0.0f) {
        step_enemies(g);
        g->enemy_step_timer = g->enemy_step_interval;
    }

    float shoot_every = clampf(1.1f - (float)g->wave * 0.08f, 0.35f, 1.1f);
    g->enemy_shoot_timer -= dt;
    if (g->enemy_shoot_timer <= 0.0f) {
        enemy_try_shoot(g);
        g->enemy_shoot_timer = shoot_every * (0.6f + ((float)rand() / (float)RAND_MAX) * 0.8f);
    }
}

static void update_ufo(Game *g, float dt)
{
    if (g->ufo.active) {
        g->ufo.x += g->ufo.vx * dt;
        if ((g->ufo.vx > 0.0f && g->ufo.x > (float)SCREEN_W + 20.0f) ||
            (g->ufo.vx < 0.0f && g->ufo.x < -UFO_W - 20.0f)) {
            g->ufo.active = false;
            g->ufo_spawn_timer = UFO_MIN_INTERVAL +
                                 ((float)rand() / (float)RAND_MAX) *
                                     (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);
        }
        return;
    }

    g->ufo_spawn_timer -= dt;
    if (g->ufo_spawn_timer <= 0.0f && g->enemy_alive > 0) {
        g->ufo.active = true;
        bool left = (rand() % 2) == 0;
        g->ufo.y = 36.0f;
        g->ufo.x = left ? -UFO_W : (float)SCREEN_W;
        g->ufo.vx = left ? UFO_SPEED : -UFO_SPEED;
        static const int pts[] = {50, 100, 150, 300};
        g->ufo.points = pts[rand() % 4];
        audio_beep(g, 660.0f, 0.15f, 0.2f);
    }
}

static void update_bullets(Game *g, float dt)
{
    for (int i = 0; i < MAX_PLAYER_BULLETS; i++) {
        Bullet *b = &g->player_bullets[i];
        if (!b->active) {
            continue;
        }
        b->y += b->vy * dt;
        if (b->y + BULLET_H < 0.0f) {
            b->active = false;
            continue;
        }

        /* shields */
        for (int s = 0; s < MAX_SHIELDS; s++) {
            if (shield_hit(&g->shields[s], b->x, b->y, BULLET_W, BULLET_H)) {
                b->active = false;
                particles_burst(g, b->x, b->y, 6, 80, 200, 80);
                break;
            }
        }
        if (!b->active) {
            continue;
        }

        /* enemies */
        for (int r = 0; r < ENEMY_ROWS && b->active; r++) {
            for (int c = 0; c < ENEMY_COLS; c++) {
                Enemy *e = &g->enemies[r][c];
                if (!e->alive) {
                    continue;
                }
                if (rects_overlap(b->x, b->y, BULLET_W, BULLET_H,
                                  e->x, e->y, ENEMY_W, ENEMY_H)) {
                    e->alive = false;
                    b->active = false;
                    g->enemy_alive--;
                    g->score += enemy_points(e->type);
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
                    particles_burst(g, e->x + ENEMY_W * 0.5f,
                                    e->y + ENEMY_H * 0.5f, 18, cr, cg, cb);
                    audio_beep(g, 320.0f + (float)e->type * 40.0f, 0.07f, 0.3f);
                    break;
                }
            }
        }
        if (!b->active) {
            continue;
        }

        /* ufo */
        if (g->ufo.active &&
            rects_overlap(b->x, b->y, BULLET_W, BULLET_H,
                          g->ufo.x, g->ufo.y, UFO_W, UFO_H)) {
            g->score += g->ufo.points;
            particles_burst(g, g->ufo.x + UFO_W * 0.5f,
                            g->ufo.y + UFO_H * 0.5f, 28, 255, 80, 200);
            audio_beep(g, 990.0f, 0.12f, 0.35f);
            g->ufo.active = false;
            b->active = false;
            g->ufo_spawn_timer = UFO_MIN_INTERVAL +
                                 ((float)rand() / (float)RAND_MAX) *
                                     (UFO_MAX_INTERVAL - UFO_MIN_INTERVAL);
        }
    }

    for (int i = 0; i < MAX_ENEMY_BULLETS; i++) {
        Bullet *b = &g->enemy_bullets[i];
        if (!b->active) {
            continue;
        }
        b->y += b->vy * dt;
        if (b->y > (float)SCREEN_H) {
            b->active = false;
            continue;
        }

        for (int s = 0; s < MAX_SHIELDS; s++) {
            if (shield_hit(&g->shields[s], b->x, b->y, BULLET_W, BULLET_H)) {
                b->active = false;
                particles_burst(g, b->x, b->y, 6, 200, 80, 80);
                break;
            }
        }
        if (!b->active) {
            continue;
        }

        if (g->player.alive &&
            rects_overlap(b->x, b->y, BULLET_W, BULLET_H,
                          g->player.x, g->player.y, PLAYER_W, PLAYER_H)) {
            b->active = false;
            kill_player(g);
        }
    }
}

void game_update(Game *g, float dt)
{
    g->star_phase += dt;

    if (g->state == STATE_MENU || g->state == STATE_PAUSED || g->state == STATE_GAME_OVER) {
        particles_update(g, dt);
        return;
    }

    if (g->state == STATE_WAVE_CLEAR) {
        g->state_timer -= dt;
        particles_update(g, dt);
        if (g->state_timer <= 0.0f) {
            g->wave += 1;
            game_spawn_wave(g);
            shields_init(g);
            g->state = STATE_PLAYING;
            audio_beep(g, 700.0f, 0.1f, 0.3f);
        }
        return;
    }

    /* PLAYING */
    update_player(g, dt);
    if (g->state != STATE_PLAYING) {
        particles_update(g, dt);
        return;
    }

    update_enemies(g, dt);
    update_ufo(g, dt);
    update_bullets(g, dt);
    particles_update(g, dt);
    audio_update(g, dt);

    if (g->enemy_alive <= 0 && g->state == STATE_PLAYING) {
        g->state = STATE_WAVE_CLEAR;
        g->state_timer = 1.5f;
        clear_bullets(g);
        audio_beep(g, 523.25f, 0.2f, 0.35f);
    }
}

void game_run(Game *g)
{
    Uint64 prev = SDL_GetPerformanceCounter();
    const Uint64 freq = SDL_GetPerformanceFrequency();
    float accumulator = 0.0f;

    while (g->running) {
        SDL_Event e;
        while (SDL_PollEvent(&e)) {
            game_handle_event(g, &e);
        }

        Uint64 now = SDL_GetPerformanceCounter();
        float frame_dt = (float)(now - prev) / (float)freq;
        prev = now;
        if (frame_dt > 0.1f) {
            frame_dt = 0.1f;
        }
        accumulator += frame_dt;

        while (accumulator >= FIXED_DT) {
            game_update(g, FIXED_DT);
            accumulator -= FIXED_DT;
        }

        game_render(g);
    }
}
