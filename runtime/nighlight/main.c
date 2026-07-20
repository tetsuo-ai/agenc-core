#define _POSIX_C_SOURCE 200809L
#include "nighlight.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <unistd.h>
#include <time.h>
#include <signal.h>

static Game *g_game_ptr = NULL;

static void on_signal(int sig) {
    (void)sig;
    if (g_game_ptr) g_game_ptr->state = STATE_QUIT;
    term_restore();
    input_shutdown();
    _exit(1);
}

static void msleep(int ms) {
    struct timespec ts;
    ts.tv_sec = ms / 1000;
    ts.tv_nsec = (long)(ms % 1000) * 1000000L;
    nanosleep(&ts, NULL);
}

int main(int argc, char **argv) {
    bool smoke = false;
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--smoke") == 0) smoke = true;
        if (strcmp(argv[i], "-h") == 0 || strcmp(argv[i], "--help") == 0) {
            puts("NIGHLIGHT — top-down flashlight horror (terminal)");
            puts("Usage: ./nighlight [--smoke]");
            puts("Controls: WASD/arrows move, F light, . wait, R restart, Q quit");
            return 0;
        }
    }

    Game g;
    g_game_ptr = &g;
    signal(SIGINT, on_signal);
    signal(SIGTERM, on_signal);

    game_init(&g, smoke);
    input_init(smoke);

    if (!smoke) term_init();

    /* initial FoV */
    fov_compute(&g.map, g.player.x, g.player.y, FOV_RADIUS_MAX);

    if (smoke) {
        /* Scripted / piped input loop — no alt screen; print banners for smoke test */
        puts("NIGHLIGHT smoke mode");
        int steps = 0;
        const int max_steps = 200;
        while (g.state != STATE_QUIT && steps < max_steps) {
            Input in = input_poll(&g);
            if (steps == 0 && g.state == STATE_PLAYING) {
                /* already playing in smoke */
            }
            if (in == IN_NONE && steps > 5) {
                /* auto-wander a bit when input exhausted */
                static const Input path[] = {
                    IN_RIGHT, IN_RIGHT, IN_DOWN, IN_DOWN, IN_LEFT, IN_UP, IN_WAIT,
                    IN_TOGGLE_LIGHT, IN_RIGHT, IN_RIGHT, IN_RIGHT, IN_DOWN
                };
                in = path[steps % (int)(sizeof(path) / sizeof(path[0]))];
            }
            if (in == IN_QUIT) break;
            game_update(&g, in == IN_NONE ? IN_WAIT : in);
            steps++;
            g.smoke_steps = steps;
            if (g.state == STATE_WIN || g.state == STATE_LOSE) break;
            msleep(5);
        }
        printf("NIGHLIGHT smoke done steps=%d state=%d keys=%d bat=%.1f san=%.1f\n",
               steps, (int)g.state, g.player.keys, g.player.battery, g.player.sanity);
        input_shutdown();
        return 0;
    }

    while (g.state != STATE_QUIT) {
        Input in = input_poll(&g);

        if (g.state == STATE_TITLE) {
            render_title(&g);
            game_update(&g, in);
            msleep(TICK_MS);
            continue;
        }
        if (g.state == STATE_WIN) {
            render_end(&g, true);
            game_update(&g, in);
            msleep(TICK_MS);
            continue;
        }
        if (g.state == STATE_LOSE) {
            render_end(&g, false);
            game_update(&g, in);
            msleep(TICK_MS);
            continue;
        }

        /* Only advance world on input or slow idle tick for ambient drain */
        static int idle = 0;
        if (in != IN_NONE) {
            game_update(&g, in);
            idle = 0;
        } else {
            idle++;
            /* ambient tick every ~400ms for battery/sanity/stalker while standing */
            if (idle >= 8) {
                game_update(&g, IN_WAIT);
                idle = 0;
            }
        }

        if (g.state == STATE_PLAYING)
            render_frame(&g);
        else if (g.state == STATE_WIN)
            render_end(&g, true);
        else if (g.state == STATE_LOSE)
            render_end(&g, false);

        msleep(TICK_MS);
    }

    term_restore();
    input_shutdown();
    g_game_ptr = NULL;
    return 0;
}
