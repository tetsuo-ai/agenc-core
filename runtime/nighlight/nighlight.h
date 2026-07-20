#ifndef NIGHLIGHT_H
#define NIGHLIGHT_H

#include <stddef.h>
#include <stdint.h>
#include <stdbool.h>

#define MAP_W 48
#define MAP_H 24
#define MAX_KEYS 4
#define MAX_BATTERIES 6
#define FOV_RADIUS_MAX 8
#define TICK_MS 50
#define BATTERY_MAX 100.0f
#define SANITY_MAX 100.0f

typedef enum {
    TILE_FLOOR = 0,
    TILE_WALL,
    TILE_DOOR_LOCKED,
    TILE_DOOR_OPEN,
    TILE_EXIT_LOCKED,
    TILE_EXIT_OPEN
} TileType;

typedef enum {
    STATE_TITLE = 0,
    STATE_PLAYING,
    STATE_WIN,
    STATE_LOSE,
    STATE_QUIT
} GameState;

typedef enum {
    LOSE_NONE = 0,
    LOSE_CAUGHT,
    LOSE_SANITY
} LoseReason;

typedef struct {
    int x, y;
} Point;

typedef struct {
    int x, y;
    float battery;      /* 0..100 */
    float sanity;       /* 0..100 */
    bool flashlight_on;
    int keys;
    int keys_needed;
    bool alive;
} Player;

typedef enum {
    STALK_WANDER = 0,
    STALK_ALERT,
    STALK_CHASE
} StalkMode;

typedef struct {
    int x, y;
    int tx, ty;         /* wander target */
    StalkMode mode;
    int mode_timer;     /* ticks */
    int last_seen_x, last_seen_y;
    bool active;
} Stalker;

typedef struct {
    int x, y;
    bool taken;
} Pickup;

typedef struct {
    TileType tiles[MAP_H][MAP_W];
    bool visible[MAP_H][MAP_W];
    bool explored[MAP_H][MAP_W];
    bool blocks_light[MAP_H][MAP_W];
    bool blocks_move[MAP_H][MAP_W];
    Pickup keys[MAX_KEYS];
    int key_count;
    Pickup batteries[MAX_BATTERIES];
    int battery_count;
    int exit_x, exit_y;
    int spawn_x, spawn_y;
    int stalk_spawn_x, stalk_spawn_y;
} Map;

typedef struct {
    Map map;
    Player player;
    Stalker stalker;
    GameState state;
    LoseReason lose_reason;
    int tick;
    float flicker;          /* flashlight flicker intensity 0..1 */
    unsigned rng;
    bool smoke;             /* non-interactive smoke mode */
    int smoke_steps;
    char message[96];
    int message_ttl;
    /* sanity FX */
    float shake;
    bool invert_pulse;
    float vignette;         /* 0..1 dark edge pulse at low sanity */
} Game;

/* util.c */
unsigned rng_next(unsigned *state);
int rng_int(unsigned *state, int lo, int hi);
float clampf(float v, float lo, float hi);
int clampi(int v, int lo, int hi);
int iabs(int v);
int manh(int x0, int y0, int x1, int y1);
bool in_bounds(int x, int y);

/* map.c */
void map_generate(Map *m, unsigned *rng);
bool map_walkable(const Map *m, int x, int y);
void map_refresh_flags(Map *m);

/* fov.c — recursive shadowcasting */
void fov_compute(Map *m, int ox, int oy, int radius);

/* entity.c */
void player_init(Player *p, int x, int y, int keys_needed);
void stalker_init(Stalker *s, int x, int y);
void stalker_update(Game *g);
bool los_clear(const Map *m, int x0, int y0, int x1, int y1);
void try_move_player(Game *g, int dx, int dy);
void game_pickup(Game *g);
void game_use_exit(Game *g);

/* render.c */
void term_init(void);
void term_restore(void);
void term_clear(void);
void render_frame(const Game *g);
void render_title(const Game *g);
void render_end(const Game *g, bool win);

/* input.c */
typedef enum {
    IN_NONE = 0,
    IN_UP, IN_DOWN, IN_LEFT, IN_RIGHT,
    IN_TOGGLE_LIGHT,
    IN_WAIT,
    IN_QUIT,
    IN_RESTART,
    IN_START
} Input;

void input_init(bool smoke);
void input_shutdown(void);
Input input_poll(Game *g);

/* game.c */
void game_init(Game *g, bool smoke);
void game_restart(Game *g);
void game_update(Game *g, Input in);
void game_set_msg(Game *g, const char *msg);

#endif /* NIGHLIGHT_H */
