#include "game.h"
#include <stdlib.h>
#include <math.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

static float frand(float a, float b)
{
    return a + ((float)rand() / (float)RAND_MAX) * (b - a);
}

void particles_burst(Game *g, float x, float y, int count,
                     uint8_t r, uint8_t gr, uint8_t b)
{
    int spawned = 0;
    for (int i = 0; i < MAX_PARTICLES && spawned < count; i++) {
        Particle *p = &g->particles[i];
        if (p->active) {
            continue;
        }
        float angle = frand(0.0f, (float)(M_PI * 2.0));
        float speed = frand(40.0f, 220.0f);
        p->x = x;
        p->y = y;
        p->vx = cosf(angle) * speed;
        p->vy = sinf(angle) * speed;
        p->max_life = frand(0.25f, 0.75f);
        p->life = p->max_life;
        p->r = r;
        p->g = gr;
        p->b = b;
        p->a = 255;
        p->size = frand(2.0f, 5.0f);
        p->active = true;
        spawned++;
    }
}

void particles_update(Game *g, float dt)
{
    for (int i = 0; i < MAX_PARTICLES; i++) {
        Particle *p = &g->particles[i];
        if (!p->active) {
            continue;
        }
        p->x += p->vx * dt;
        p->y += p->vy * dt;
        p->vy += 120.0f * dt;
        p->life -= dt;
        if (p->life <= 0.0f) {
            p->active = false;
            continue;
        }
        float t = p->life / p->max_life;
        p->a = (uint8_t)(t * 255.0f);
    }
}

void particles_render(Game *g)
{
    for (int i = 0; i < MAX_PARTICLES; i++) {
        Particle *p = &g->particles[i];
        if (!p->active) {
            continue;
        }
        SDL_SetRenderDrawColor(g->renderer, p->r, p->g, p->b, p->a);
        SDL_Rect rc = {
            (int)(p->x - p->size * 0.5f),
            (int)(p->y - p->size * 0.5f),
            (int)p->size,
            (int)p->size
        };
        SDL_RenderFillRect(g->renderer, &rc);
    }
}
