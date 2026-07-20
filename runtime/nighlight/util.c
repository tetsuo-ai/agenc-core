#include "nighlight.h"

unsigned rng_next(unsigned *state) {
    /* xorshift32 */
    unsigned x = *state;
    if (x == 0) x = 0xA3C59AC3u;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    return x;
}

int rng_int(unsigned *state, int lo, int hi) {
    if (hi <= lo) return lo;
    unsigned span = (unsigned)(hi - lo + 1);
    return lo + (int)(rng_next(state) % span);
}

float clampf(float v, float lo, float hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

int clampi(int v, int lo, int hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
}

int iabs(int v) { return v < 0 ? -v : v; }

int manh(int x0, int y0, int x1, int y1) {
    return iabs(x1 - x0) + iabs(y1 - y0);
}

bool in_bounds(int x, int y) {
    return x >= 0 && y >= 0 && x < MAP_W && y < MAP_H;
}
