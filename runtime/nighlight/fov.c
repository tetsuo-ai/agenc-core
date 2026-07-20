#include "nighlight.h"
#include <string.h>
#include <math.h>

/* Recursive shadowcasting (Björn Bergström / roguebasin style) */

static int mult[4][8] = {
    {1, 0, 0, -1, -1, 0, 0, 1},
    {0, 1, -1, 0, 0, -1, 1, 0},
    {0, 1, 1, 0, 0, -1, -1, 0},
    {1, 0, 0, 1, -1, 0, 0, -1}
};

static void cast_light(Map *m, int cx, int cy, int row, float start, float end,
                       int radius, int xx, int xy, int yx, int yy, int id) {
    (void)id;
    if (start < end) return;
    float new_start = 0.0f;
    for (int j = row; j <= radius; j++) {
        int dx = -j - 1;
        int dy = -j;
        bool blocked = false;
        while (dx <= 0) {
            dx++;
            int X = cx + dx * xx + dy * xy;
            int Y = cy + dx * yx + dy * yy;
            float l_slope = ((float)dx - 0.5f) / ((float)dy + 0.5f);
            float r_slope = ((float)dx + 0.5f) / ((float)dy - 0.5f);
            if (start < r_slope) continue;
            if (end > l_slope) break;
            if (!in_bounds(X, Y)) continue;

            float dist = sqrtf((float)(dx * dx + dy * dy));
            if (dist <= (float)radius + 0.5f) {
                m->visible[Y][X] = true;
                m->explored[Y][X] = true;
            }

            if (blocked) {
                if (m->blocks_light[Y][X]) {
                    new_start = r_slope;
                    continue;
                } else {
                    blocked = false;
                    start = new_start;
                }
            } else {
                if (m->blocks_light[Y][X] && j < radius) {
                    blocked = true;
                    cast_light(m, cx, cy, j + 1, start, l_slope, radius, xx, xy, yx, yy, id + 1);
                    new_start = r_slope;
                }
            }
        }
        if (blocked) break;
    }
}

void fov_compute(Map *m, int ox, int oy, int radius) {
    memset(m->visible, 0, sizeof(m->visible));
    if (!in_bounds(ox, oy)) return;
    m->visible[oy][ox] = true;
    m->explored[oy][ox] = true;
    if (radius <= 0) return;
    for (int oct = 0; oct < 8; oct++) {
        cast_light(m, ox, oy, 1, 1.0f, 0.0f, radius,
                   mult[0][oct], mult[1][oct], mult[2][oct], mult[3][oct], 0);
    }
}
