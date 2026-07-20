#ifndef SPACE_INVADERS_GAME_H
#define SPACE_INVADERS_GAME_H

#include <SDL2/SDL.h>
#include <stdbool.h>
#include <stdint.h>

#define SCREEN_W 800
#define SCREEN_H 600
#define TARGET_FPS 60
#define FIXED_DT (1.0f / (float)TARGET_FPS)

#define PLAYER_W 40
#define PLAYER_H 20
#define PLAYER_SPEED 280.0f
#define PLAYER_COOLDOWN 0.35f
#define PLAYER_MAX_LIVES 3

#define BULLET_W 4
#define BULLET_H 12
#define PLAYER_BULLET_SPEED 420.0f
#define ENEMY_BULLET_SPEED 220.0f
#define MAX_PLAYER_BULLETS 4
#define MAX_ENEMY_BULLETS 10

#define ENEMY_COLS 11
#define ENEMY_ROWS 5
#define ENEMY_W 28
#define ENEMY_H 20
#define ENEMY_H_PAD 12
#define ENEMY_V_PAD 10
#define ENEMY_START_Y 70.0f
#define ENEMY_DROP 18.0f

#define MAX_PARTICLES 256
#define MAX_SHIELDS 4
#define SHIELD_W 66
#define SHIELD_H 48
#define SHIELD_BLOCK 6

#define UFO_W 40
#define UFO_H 18
#define UFO_SPEED 120.0f
#define UFO_MIN_INTERVAL 12.0f
#define UFO_MAX_INTERVAL 22.0f

typedef enum {
    STATE_MENU = 0,
    STATE_PLAYING,
    STATE_PAUSED,
    STATE_GAME_OVER,
    STATE_WAVE_CLEAR
} GameState;

typedef enum {
    ENEMY_SQUID = 0,
    ENEMY_CRAB,
    ENEMY_OCTOPUS
} EnemyType;

typedef struct {
    float x, y;
    float vx, vy;
    float life;
    float max_life;
    uint8_t r, g, b, a;
    float size;
    bool active;
} Particle;

typedef struct {
    float x, y;
    float vy;
    bool active;
    bool from_player;
} Bullet;

typedef struct {
    float x, y;
    EnemyType type;
    bool alive;
    int anim_frame;
} Enemy;

typedef struct {
    float x, y;
    bool blocks[(SHIELD_H / SHIELD_BLOCK) * (SHIELD_W / SHIELD_BLOCK)];
    bool active;
} Shield;

typedef struct {
    float x, y;
    float vx;
    bool active;
    int points;
} Ufo;

typedef struct {
    float x, y;
    float cooldown;
    int lives;
    bool alive;
    bool moving_left;
    bool moving_right;
    bool want_shoot;
} Player;

typedef struct {
    SDL_Window *window;
    SDL_Renderer *renderer;
    bool running;
    bool sdl_ready;

    GameState state;
    Player player;

    Bullet player_bullets[MAX_PLAYER_BULLETS];
    Bullet enemy_bullets[MAX_ENEMY_BULLETS];
    Enemy enemies[ENEMY_ROWS][ENEMY_COLS];
    Shield shields[MAX_SHIELDS];
    Particle particles[MAX_PARTICLES];
    Ufo ufo;

    int enemy_alive;
    int enemy_dir; /* +1 right, -1 left */
    float enemy_step_timer;
    float enemy_step_interval;
    int enemy_anim_tick;
    float enemy_shoot_timer;

    int score;
    int high_score;
    int wave;
    float state_timer;

    float ufo_spawn_timer;
    float star_phase;

    /* simple audio */
    SDL_AudioDeviceID audio_dev;
    bool audio_ok;
    float beep_phase;
    float beep_freq;
    float beep_time_left;
    float beep_volume;
} Game;

bool game_init(Game *g);
void game_shutdown(Game *g);
void game_run(Game *g);

void game_reset_run(Game *g, bool full_reset);
void game_spawn_wave(Game *g);
void game_update(Game *g, float dt);
void game_render(Game *g);
void game_handle_event(Game *g, const SDL_Event *e);

void particles_burst(Game *g, float x, float y, int count,
                     uint8_t r, uint8_t gr, uint8_t b);
void particles_update(Game *g, float dt);
void particles_render(Game *g);

bool audio_init(Game *g);
void audio_shutdown(Game *g);
void audio_beep(Game *g, float freq, float duration, float volume);
void audio_update(Game *g, float dt);

#endif /* SPACE_INVADERS_GAME_H */
