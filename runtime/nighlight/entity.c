#include "nighlight.h"
#include <string.h>
#include <stdio.h>

void player_init(Player *p, int x, int y, int keys_needed) {
    memset(p, 0, sizeof(*p));
    p->x = x;
    p->y = y;
    p->battery = BATTERY_MAX;
    p->sanity = SANITY_MAX;
    p->flashlight_on = true;
    p->keys = 0;
    p->keys_needed = keys_needed;
    p->alive = true;
}

void stalker_init(Stalker *s, int x, int y) {
    memset(s, 0, sizeof(*s));
    s->x = x;
    s->y = y;
    s->tx = x;
    s->ty = y;
    s->mode = STALK_WANDER;
    s->mode_timer = 0;
    s->active = true;
    s->last_seen_x = x;
    s->last_seen_y = y;
}

/* Bresenham LOS — blocked by light-blocking tiles (not endpoints) */
bool los_clear(const Map *m, int x0, int y0, int x1, int y1) {
    int dx = iabs(x1 - x0), sx = x0 < x1 ? 1 : -1;
    int dy = -iabs(y1 - y0), sy = y0 < y1 ? 1 : -1;
    int err = dx + dy;
    int x = x0, y = y0;
    for (;;) {
        if (!(x == x0 && y == y0) && !(x == x1 && y == y1)) {
            if (!in_bounds(x, y) || m->blocks_light[y][x]) return false;
        }
        if (x == x1 && y == y1) break;
        int e2 = 2 * err;
        if (e2 >= dy) { err += dy; x += sx; }
        if (e2 <= dx) { err += dx; y += sy; }
    }
    return true;
}

static void step_toward(Game *g, int *x, int *y, int tx, int ty) {
    int bx = *x, by = *y;
    int best = manh(bx, by, tx, ty);
    const int dirs[8][2] = {{1,0},{-1,0},{0,1},{0,-1},{1,1},{1,-1},{-1,1},{-1,-1}};
    /* shuffle lightly via rng */
    int order[8] = {0,1,2,3,4,5,6,7};
    for (int i = 7; i > 0; i--) {
        int j = rng_int(&g->rng, 0, i);
        int t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (int k = 0; k < 8; k++) {
        int i = order[k];
        int nx = *x + dirs[i][0];
        int ny = *y + dirs[i][1];
        if (!map_walkable(&g->map, nx, ny)) continue;
        /* don't walk onto player until chase resolves separately */
        int d = manh(nx, ny, tx, ty);
        if (d < best) {
            best = d;
            bx = nx; by = ny;
        }
    }
    *x = bx; *y = by;
}

void stalker_update(Game *g) {
    Stalker *s = &g->stalker;
    Player *p = &g->player;
    if (!s->active || !p->alive) return;

    /* Hearing: player footsteps when moving is handled via mode_timer boost externally;
       here we check LOS vision every stalker tick */
    bool sees = false;
    int dist = manh(s->x, s->y, p->x, p->y);
    int vision = 10;
    if (p->flashlight_on && p->battery > 0.5f) {
        /* light makes you more visible */
        vision = 14;
    }
    if (dist <= vision && los_clear(&g->map, s->x, s->y, p->x, p->y)) {
        /* if player light off and far, harder to see */
        if (!(p->flashlight_on && p->battery > 0.5f) && dist > 6) {
            /* chance to miss */
            if (rng_int(&g->rng, 0, 2) != 0) sees = false;
            else sees = true;
        } else {
            sees = true;
        }
    }

    if (sees) {
        s->mode = STALK_CHASE;
        s->last_seen_x = p->x;
        s->last_seen_y = p->y;
        s->mode_timer = 40;
        game_set_msg(g, "Something has seen you...");
    } else if (s->mode == STALK_CHASE) {
        s->mode_timer--;
        if (s->mode_timer <= 0) {
            s->mode = STALK_ALERT;
            s->mode_timer = 30;
            s->tx = s->last_seen_x;
            s->ty = s->last_seen_y;
        }
    } else if (s->mode == STALK_ALERT) {
        s->mode_timer--;
        if (s->mode_timer <= 0 || (s->x == s->tx && s->y == s->ty)) {
            s->mode = STALK_WANDER;
            s->mode_timer = 0;
        }
    }

    /* Hearing radius when player recently made noise (message or battery flicker unused):
       if player is very close, alert */
    if (s->mode == STALK_WANDER && dist <= 3) {
        s->mode = STALK_ALERT;
        s->tx = p->x;
        s->ty = p->y;
        s->mode_timer = 20;
    }

    int speed = (s->mode == STALK_CHASE) ? 1 : (s->mode == STALK_ALERT) ? 1 : 2;
    /* move every N game ticks: chase every tick, alert every 2, wander every 3 */
    int period = (s->mode == STALK_CHASE) ? 2 : (s->mode == STALK_ALERT) ? 3 : 4;
    if ((g->tick % period) != 0) return;
    (void)speed;

    if (s->mode == STALK_CHASE) {
        step_toward(g, &s->x, &s->y, p->x, p->y);
    } else if (s->mode == STALK_ALERT) {
        step_toward(g, &s->x, &s->y, s->tx, s->ty);
    } else {
        if (s->mode_timer <= 0 || (s->x == s->tx && s->y == s->ty)) {
            /* pick new wander target on floor */
            for (int t = 0; t < 30; t++) {
                int nx = rng_int(&g->rng, 1, MAP_W - 2);
                int ny = rng_int(&g->rng, 1, MAP_H - 2);
                if (map_walkable(&g->map, nx, ny)) {
                    s->tx = nx; s->ty = ny;
                    break;
                }
            }
            s->mode_timer = 40;
        }
        s->mode_timer--;
        step_toward(g, &s->x, &s->y, s->tx, s->ty);
    }

    /* Catch player */
    if (s->x == p->x && s->y == p->y) {
        p->alive = false;
        g->state = STATE_LOSE;
        g->lose_reason = LOSE_CAUGHT;
        game_set_msg(g, "The dark takes you.");
    }
}

void game_pickup(Game *g) {
    Player *p = &g->player;
    Map *m = &g->map;
    for (int i = 0; i < m->key_count; i++) {
        if (!m->keys[i].taken && m->keys[i].x == p->x && m->keys[i].y == p->y) {
            m->keys[i].taken = true;
            p->keys++;
            char buf[96];
            snprintf(buf, sizeof(buf), "Picked up a key (%d/%d).", p->keys, p->keys_needed);
            game_set_msg(g, buf);
            /* unlock a door if any locked remain, or exit when enough keys */
            if (p->keys >= p->keys_needed) {
                m->tiles[m->exit_y][m->exit_x] = TILE_EXIT_OPEN;
                map_refresh_flags(m);
                game_set_msg(g, "The exit unlocks...");
            }
            /* unlock nearest locked door */
            int best = 999, bx = -1, by = -1;
            for (int y = 0; y < MAP_H; y++) {
                for (int x = 0; x < MAP_W; x++) {
                    if (m->tiles[y][x] == TILE_DOOR_LOCKED) {
                        int d = manh(x, y, p->x, p->y);
                        if (d < best) { best = d; bx = x; by = y; }
                    }
                }
            }
            if (bx >= 0) {
                m->tiles[by][bx] = TILE_DOOR_OPEN;
                map_refresh_flags(m);
                game_set_msg(g, "A door unlocks somewhere...");
            }
        }
    }
    for (int i = 0; i < m->battery_count; i++) {
        if (!m->batteries[i].taken && m->batteries[i].x == p->x && m->batteries[i].y == p->y) {
            m->batteries[i].taken = true;
            p->battery = clampf(p->battery + 45.0f, 0.0f, BATTERY_MAX);
            game_set_msg(g, "Fresh batteries. Light holds.");
        }
    }
}

void try_move_player(Game *g, int dx, int dy) {
    Player *p = &g->player;
    int nx = p->x + dx;
    int ny = p->y + dy;
    if (!map_walkable(&g->map, nx, ny)) {
        TileType t = g->map.tiles[ny][nx];
        if (in_bounds(nx, ny) && (t == TILE_DOOR_LOCKED || t == TILE_EXIT_LOCKED)) {
            game_set_msg(g, "Locked. Need more keys.");
        }
        return;
    }
    p->x = nx;
    p->y = ny;
    /* walked into the stalker */
    if (g->stalker.active && g->stalker.x == p->x && g->stalker.y == p->y) {
        p->alive = false;
        g->state = STATE_LOSE;
        g->lose_reason = LOSE_CAUGHT;
        game_set_msg(g, "The dark takes you.");
        return;
    }
    /* noise: alert stalker if nearby */
    int d = manh(g->stalker.x, g->stalker.y, p->x, p->y);
    if (d <= 8 && g->stalker.mode == STALK_WANDER) {
        if (rng_int(&g->rng, 0, 5) == 0) {
            g->stalker.mode = STALK_ALERT;
            g->stalker.tx = p->x;
            g->stalker.ty = p->y;
            g->stalker.mode_timer = 25;
            game_set_msg(g, "A floorboard creaks...");
        }
    }
    game_pickup(g);
    game_use_exit(g);
}

void game_use_exit(Game *g) {
    Player *p = &g->player;
    if (p->x == g->map.exit_x && p->y == g->map.exit_y &&
        g->map.tiles[p->y][p->x] == TILE_EXIT_OPEN) {
        g->state = STATE_WIN;
        game_set_msg(g, "You escape into the night.");
    }
}
