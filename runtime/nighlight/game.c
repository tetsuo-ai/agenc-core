#include "nighlight.h"
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <time.h>

void game_set_msg(Game *g, const char *msg) {
    snprintf(g->message, sizeof(g->message), "%s", msg);
    g->message_ttl = 40;
}

static void setup_world(Game *g) {
    map_generate(&g->map, &g->rng);
    player_init(&g->player, g->map.spawn_x, g->map.spawn_y, g->map.key_count);
    stalker_init(&g->stalker, g->map.stalk_spawn_x, g->map.stalk_spawn_y);
    g->tick = 0;
    g->flicker = 1.0f;
    g->shake = 0.0f;
    g->invert_pulse = false;
    g->vignette = 0.0f;
    g->lose_reason = LOSE_NONE;
    g->message[0] = '\0';
    g->message_ttl = 0;
    game_set_msg(g, "Your light is all that stands between you and it.");
}

void game_init(Game *g, bool smoke) {
    memset(g, 0, sizeof(*g));
    g->smoke = smoke;
    g->rng = (unsigned)time(NULL) ^ 0xA17E41u;
    if (g->rng == 0) g->rng = 1u;
    g->state = smoke ? STATE_PLAYING : STATE_TITLE;
    setup_world(g);
}

void game_restart(Game *g) {
    bool smoke = g->smoke;
    unsigned seed = rng_next(&g->rng);
    memset(g, 0, sizeof(*g));
    g->smoke = smoke;
    g->rng = seed ? seed : 1u;
    g->state = STATE_PLAYING;
    setup_world(g);
}

static int current_fov_radius(const Game *g) {
    const Player *p = &g->player;
    if (!p->flashlight_on || p->battery <= 0.1f) return 1; /* eyes adjust faintly */
    float br = p->battery / BATTERY_MAX;
    int r = 2 + (int)(br * (FOV_RADIUS_MAX - 2));
    /* flicker can shrink radius briefly */
    if (g->flicker < 0.35f) r = r > 2 ? r - 2 : 1;
    else if (g->flicker < 0.6f) r = r > 1 ? r - 1 : 1;
    return clampi(r, 1, FOV_RADIUS_MAX);
}

static void update_light_and_sanity(Game *g) {
    Player *p = &g->player;
    Stalker *s = &g->stalker;

    /* Battery drain + flicker */
    if (p->flashlight_on && p->battery > 0.0f) {
        p->battery -= 0.08f; /* ~60s full drain at 50ms ticks roughly slower */
        /* random flicker when low */
        if (p->battery < 35.0f) {
            if (rng_int(&g->rng, 0, 12) == 0)
                g->flicker = 0.15f + (rng_next(&g->rng) % 50) / 100.0f;
            else
                g->flicker = 0.7f + (rng_next(&g->rng) % 30) / 100.0f;
        } else if (p->battery < 60.0f && rng_int(&g->rng, 0, 40) == 0) {
            g->flicker = 0.4f + (rng_next(&g->rng) % 40) / 100.0f;
        } else {
            g->flicker = 0.9f + (rng_next(&g->rng) % 10) / 100.0f;
        }
        if (p->battery <= 0.0f) {
            p->battery = 0.0f;
            p->flashlight_on = false;
            game_set_msg(g, "Batteries dead. Blind in the dark.");
        }
    } else {
        g->flicker = 0.2f;
    }

    /* Sanity: drops in darkness and near stalker */
    bool lit = p->flashlight_on && p->battery > 0.1f;
    if (!lit) {
        p->sanity -= 0.12f;
    } else {
        p->sanity += 0.03f; /* slow recover in light */
    }

    int d = manh(p->x, p->y, s->x, s->y);
    if (d <= 6) {
        float prox = (6 - d) / 6.0f;
        p->sanity -= 0.15f * prox;
        if (s->mode == STALK_CHASE) p->sanity -= 0.2f;
    }

    /* visible stalker is terrifying */
    if (in_bounds(s->x, s->y) && g->map.visible[s->y][s->x]) {
        p->sanity -= 0.25f;
        g->shake = 2.0f;
    }

    p->sanity = clampf(p->sanity, 0.0f, SANITY_MAX);
    p->battery = clampf(p->battery, 0.0f, BATTERY_MAX);

    if (g->shake > 0.0f) g->shake -= 0.1f;
    g->invert_pulse = false;
    /* vignette ramps as sanity drops below half */
    if (p->sanity < 50.0f)
        g->vignette = clampf((50.0f - p->sanity) / 50.0f, 0.0f, 1.0f);
    else
        g->vignette = fmaxf(0.0f, g->vignette - 0.02f);

    if (p->sanity < 30.0f) {
        g->shake = fmaxf(g->shake, 1.0f + (30.0f - p->sanity) / 15.0f);
        if (rng_int(&g->rng, 0, 20) == 0) g->invert_pulse = true;
    }
    if (p->sanity < 15.0f && rng_int(&g->rng, 0, 12) == 0)
        g->invert_pulse = true;

    if (p->sanity <= 0.0f) {
        p->alive = false;
        g->state = STATE_LOSE;
        g->lose_reason = LOSE_SANITY;
        game_set_msg(g, "Your mind unravels in the dark.");
    }
}

void game_update(Game *g, Input in) {
    if (g->state == STATE_QUIT) return;

    if (g->state == STATE_TITLE) {
        if (in == IN_START || in == IN_WAIT || in == IN_TOGGLE_LIGHT) {
            g->state = STATE_PLAYING;
        } else if (in == IN_QUIT) {
            g->state = STATE_QUIT;
        }
        return;
    }

    if (g->state == STATE_WIN || g->state == STATE_LOSE) {
        if (in == IN_RESTART) game_restart(g);
        else if (in == IN_QUIT) g->state = STATE_QUIT;
        return;
    }

    /* PLAYING */
    if (in == IN_QUIT) { g->state = STATE_QUIT; return; }
    if (in == IN_RESTART) { game_restart(g); return; }

    if (in == IN_TOGGLE_LIGHT) {
        if (g->player.battery <= 0.1f) {
            game_set_msg(g, "No power left.");
        } else {
            g->player.flashlight_on = !g->player.flashlight_on;
            game_set_msg(g, g->player.flashlight_on ? "Flashlight on." : "Flashlight off. Hide in dark.");
        }
    } else if (in == IN_UP) {
        try_move_player(g, 0, -1);
    } else if (in == IN_DOWN) {
        try_move_player(g, 0, 1);
    } else if (in == IN_LEFT) {
        try_move_player(g, -1, 0);
    } else if (in == IN_RIGHT) {
        try_move_player(g, 1, 0);
    } else if (in == IN_WAIT) {
        /* deliberate wait — stalker still moves */
    }

    if (g->state != STATE_PLAYING) return;

    g->tick++;
    if (g->message_ttl > 0) g->message_ttl--;

    update_light_and_sanity(g);
    if (g->state != STATE_PLAYING) return;

    stalker_update(g);
    if (g->state != STATE_PLAYING) return;

    int rad = current_fov_radius(g);
    fov_compute(&g->map, g->player.x, g->player.y, rad);
}
