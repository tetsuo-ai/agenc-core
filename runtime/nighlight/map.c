#include "nighlight.h"
#include <string.h>

static void carve_room(Map *m, int x, int y, int w, int h) {
    for (int j = y; j < y + h; j++) {
        for (int i = x; i < x + w; i++) {
            if (in_bounds(i, j)) m->tiles[j][i] = TILE_FLOOR;
        }
    }
}

static void carve_h(Map *m, int x0, int x1, int y) {
    if (x0 > x1) { int t = x0; x0 = x1; x1 = t; }
    for (int x = x0; x <= x1; x++)
        if (in_bounds(x, y)) m->tiles[y][x] = TILE_FLOOR;
}

static void carve_v(Map *m, int y0, int y1, int x) {
    if (y0 > y1) { int t = y0; y0 = y1; y1 = t; }
    for (int y = y0; y <= y1; y++)
        if (in_bounds(x, y)) m->tiles[y][x] = TILE_FLOOR;
}

void map_refresh_flags(Map *m) {
    for (int y = 0; y < MAP_H; y++) {
        for (int x = 0; x < MAP_W; x++) {
            TileType t = m->tiles[y][x];
            m->blocks_move[y][x] = (t == TILE_WALL || t == TILE_DOOR_LOCKED || t == TILE_EXIT_LOCKED);
            m->blocks_light[y][x] = (t == TILE_WALL || t == TILE_DOOR_LOCKED || t == TILE_EXIT_LOCKED);
        }
    }
}

bool map_walkable(const Map *m, int x, int y) {
    if (!in_bounds(x, y)) return false;
    return !m->blocks_move[y][x];
}

static bool floor_at(const Map *m, int x, int y) {
    return in_bounds(x, y) && m->tiles[y][x] == TILE_FLOOR;
}

static void place_pickup(Map *m, Pickup *p, unsigned *rng) {
    for (int tries = 0; tries < 400; tries++) {
        int x = rng_int(rng, 1, MAP_W - 2);
        int y = rng_int(rng, 1, MAP_H - 2);
        if (!floor_at(m, x, y)) continue;
        if (x == m->spawn_x && y == m->spawn_y) continue;
        if (x == m->exit_x && y == m->exit_y) continue;
        /* keep away from other pickups roughly */
        bool ok = true;
        for (int i = 0; i < m->key_count; i++) {
            if (!m->keys[i].taken && manh(x, y, m->keys[i].x, m->keys[i].y) < 3) ok = false;
        }
        for (int i = 0; i < m->battery_count; i++) {
            if (!m->batteries[i].taken && manh(x, y, m->batteries[i].x, m->batteries[i].y) < 2) ok = false;
        }
        if (!ok) continue;
        p->x = x; p->y = y; p->taken = false;
        return;
    }
    p->x = m->spawn_x; p->y = m->spawn_y; p->taken = false;
}

void map_generate(Map *m, unsigned *rng) {
    memset(m, 0, sizeof(*m));
    for (int y = 0; y < MAP_H; y++)
        for (int x = 0; x < MAP_W; x++)
            m->tiles[y][x] = TILE_WALL;

    /* Room-and-corridor house layout */
    typedef struct { int x, y, w, h, cx, cy; } Room;
    Room rooms[12];
    int nrooms = 0;

    for (int attempt = 0; attempt < 80 && nrooms < 10; attempt++) {
        int w = rng_int(rng, 5, 10);
        int h = rng_int(rng, 4, 7);
        int x = rng_int(rng, 1, MAP_W - w - 2);
        int y = rng_int(rng, 1, MAP_H - h - 2);
        bool overlap = false;
        for (int i = 0; i < nrooms; i++) {
            if (x < rooms[i].x + rooms[i].w + 1 && x + w + 1 > rooms[i].x &&
                y < rooms[i].y + rooms[i].h + 1 && y + h + 1 > rooms[i].y) {
                overlap = true;
                break;
            }
        }
        if (overlap) continue;
        carve_room(m, x, y, w, h);
        rooms[nrooms].x = x; rooms[nrooms].y = y;
        rooms[nrooms].w = w; rooms[nrooms].h = h;
        rooms[nrooms].cx = x + w / 2;
        rooms[nrooms].cy = y + h / 2;
        nrooms++;
    }

    if (nrooms < 3) {
        /* fallback simple layout */
        carve_room(m, 2, 2, 12, 8);
        carve_room(m, 18, 4, 10, 6);
        carve_room(m, 32, 3, 12, 10);
        carve_room(m, 10, 14, 20, 6);
        rooms[0] = (Room){2, 2, 12, 8, 8, 6};
        rooms[1] = (Room){18, 4, 10, 6, 23, 7};
        rooms[2] = (Room){32, 3, 12, 10, 38, 8};
        rooms[3] = (Room){10, 14, 20, 6, 20, 17};
        nrooms = 4;
        carve_h(m, rooms[0].cx, rooms[1].cx, rooms[0].cy);
        carve_v(m, rooms[0].cy, rooms[1].cy, rooms[1].cx);
        carve_h(m, rooms[1].cx, rooms[2].cx, rooms[1].cy);
        carve_v(m, rooms[1].cy, rooms[3].cy, rooms[1].cx);
        carve_h(m, rooms[3].cx, rooms[2].cx, rooms[3].cy);
    } else {
        for (int i = 1; i < nrooms; i++) {
            int x0 = rooms[i - 1].cx, y0 = rooms[i - 1].cy;
            int x1 = rooms[i].cx, y1 = rooms[i].cy;
            if (rng_int(rng, 0, 1) == 0) {
                carve_h(m, x0, x1, y0);
                carve_v(m, y0, y1, x1);
            } else {
                carve_v(m, y0, y1, x0);
                carve_h(m, x0, x1, y1);
            }
        }
        /* extra loops for less linear house */
        if (nrooms >= 4) {
            carve_h(m, rooms[0].cx, rooms[nrooms - 1].cx, rooms[nrooms / 2].cy);
            carve_v(m, rooms[1].cy, rooms[nrooms - 1].cy, rooms[nrooms / 2].cx);
        }
    }

    /* Border walls */
    for (int x = 0; x < MAP_W; x++) {
        m->tiles[0][x] = TILE_WALL;
        m->tiles[MAP_H - 1][x] = TILE_WALL;
    }
    for (int y = 0; y < MAP_H; y++) {
        m->tiles[y][0] = TILE_WALL;
        m->tiles[y][MAP_W - 1] = TILE_WALL;
    }

    m->spawn_x = rooms[0].cx;
    m->spawn_y = rooms[0].cy;
    m->exit_x = rooms[nrooms - 1].cx;
    m->exit_y = rooms[nrooms - 1].cy;
    m->tiles[m->exit_y][m->exit_x] = TILE_EXIT_LOCKED;

    m->stalk_spawn_x = rooms[nrooms / 2].cx;
    m->stalk_spawn_y = rooms[nrooms / 2].cy;

    /* A few internal locked doors on corridor chokepoints */
    int doors = 0;
    for (int y = 2; y < MAP_H - 2 && doors < 3; y++) {
        for (int x = 2; x < MAP_W - 2 && doors < 3; x++) {
            if (m->tiles[y][x] != TILE_FLOOR) continue;
            int n = (m->tiles[y - 1][x] == TILE_WALL) + (m->tiles[y + 1][x] == TILE_WALL);
            int e = (m->tiles[y][x - 1] == TILE_WALL) + (m->tiles[y][x + 1] == TILE_WALL);
            bool choke = (n == 2 && e == 0) || (e == 2 && n == 0);
            if (!choke) continue;
            if (manh(x, y, m->spawn_x, m->spawn_y) < 6) continue;
            if (manh(x, y, m->exit_x, m->exit_y) < 4) continue;
            if (rng_int(rng, 0, 8) != 0) continue;
            m->tiles[y][x] = TILE_DOOR_LOCKED;
            doors++;
        }
    }

    m->key_count = 3;
    for (int i = 0; i < m->key_count; i++)
        place_pickup(m, &m->keys[i], rng);

    m->battery_count = 5;
    for (int i = 0; i < m->battery_count; i++)
        place_pickup(m, &m->batteries[i], rng);

    map_refresh_flags(m);
}
