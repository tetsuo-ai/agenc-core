#include "game.h"
#include <math.h>
#include <string.h>

#ifndef M_PI
#define M_PI 3.14159265358979323846
#endif

#define SAMPLE_RATE 22050
#define AMPLITUDE 2800

static void audio_callback(void *userdata, Uint8 *stream, int len)
{
    Game *g = (Game *)userdata;
    Sint16 *out = (Sint16 *)stream;
    int samples = len / (int)sizeof(Sint16);

    memset(stream, 0, (size_t)len);
    if (g->beep_time_left <= 0.0f || g->beep_freq <= 0.0f) {
        return;
    }

    for (int i = 0; i < samples; i++) {
        float t = g->beep_phase;
        /* simple square wave */
        float s = (sinf(t) >= 0.0f) ? 1.0f : -1.0f;
        float env = g->beep_time_left > 0.05f ? 1.0f : (g->beep_time_left / 0.05f);
        if (env < 0.0f) {
            env = 0.0f;
        }
        out[i] = (Sint16)(s * AMPLITUDE * g->beep_volume * env);

        g->beep_phase += 2.0f * (float)M_PI * g->beep_freq / (float)SAMPLE_RATE;
        if (g->beep_phase > 2.0f * (float)M_PI) {
            g->beep_phase -= 2.0f * (float)M_PI;
        }

        g->beep_time_left -= 1.0f / (float)SAMPLE_RATE;
        if (g->beep_time_left <= 0.0f) {
            /* zero remaining samples */
            for (int j = i + 1; j < samples; j++) {
                out[j] = 0;
            }
            g->beep_time_left = 0.0f;
            break;
        }
    }
}

bool audio_init(Game *g)
{
    g->audio_ok = false;
    g->audio_dev = 0;
    g->beep_phase = 0.0f;
    g->beep_freq = 0.0f;
    g->beep_time_left = 0.0f;
    g->beep_volume = 0.35f;

    SDL_AudioSpec want;
    SDL_zero(want);
    want.freq = SAMPLE_RATE;
    want.format = AUDIO_S16SYS;
    want.channels = 1;
    want.samples = 512;
    want.callback = audio_callback;
    want.userdata = g;

    g->audio_dev = SDL_OpenAudioDevice(NULL, 0, &want, NULL, 0);
    if (g->audio_dev == 0) {
        SDL_Log("Audio disabled: %s", SDL_GetError());
        return false;
    }
    SDL_PauseAudioDevice(g->audio_dev, 0);
    g->audio_ok = true;
    return true;
}

void audio_shutdown(Game *g)
{
    if (g->audio_dev != 0) {
        SDL_CloseAudioDevice(g->audio_dev);
        g->audio_dev = 0;
    }
    g->audio_ok = false;
}

void audio_beep(Game *g, float freq, float duration, float volume)
{
    if (!g->audio_ok) {
        return;
    }
    SDL_LockAudioDevice(g->audio_dev);
    g->beep_freq = freq;
    g->beep_time_left = duration;
    g->beep_volume = volume;
    g->beep_phase = 0.0f;
    SDL_UnlockAudioDevice(g->audio_dev);
}

void audio_update(Game *g, float dt)
{
    (void)g;
    (void)dt;
    /* envelope handled in callback */
}
