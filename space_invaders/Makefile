# Space Invaders (SDL2)
CC         ?= gcc
PKG_CONFIG ?= pkg-config

CFLAGS  ?= -std=c11 -Wall -Wextra -Wpedantic -O2
CFLAGS  += -Iinclude
LDFLAGS ?=

# Optional local SDL2 headers extracted via: make fetch-sdl-headers
LOCAL_SDL_ROOT := $(CURDIR)/.deps/extracted
LOCAL_SDL_INC  := $(LOCAL_SDL_ROOT)/usr/include
LOCAL_SDL_ARCH := $(LOCAL_SDL_ROOT)/usr/include/x86_64-linux-gnu
LOCAL_SDL_LIB  := $(LOCAL_SDL_ROOT)/usr/lib/x86_64-linux-gnu

ifneq ($(wildcard $(LOCAL_SDL_INC)/SDL2/SDL.h),)
  CFLAGS  += -I$(LOCAL_SDL_INC) -I$(LOCAL_SDL_ARCH) -D_REENTRANT
  LDFLAGS += -L$(LOCAL_SDL_LIB) -lSDL2 -lm -Wl,-rpath,/usr/lib/x86_64-linux-gnu
else
  SDL_CFLAGS := $(shell $(PKG_CONFIG) --cflags sdl2 2>/dev/null)
  SDL_LIBS   := $(shell $(PKG_CONFIG) --libs sdl2 2>/dev/null)
  ifeq ($(strip $(SDL_LIBS)),)
    SDL_CFLAGS :=
    SDL_LIBS   := -lSDL2
  endif
  CFLAGS  += $(SDL_CFLAGS)
  LDFLAGS += $(SDL_LIBS) -lm
endif

SRC := \
	src/main.c \
	src/game.c \
	src/render.c \
	src/particles.c \
	src/audio.c

OBJ := $(SRC:src/%.c=build/%.o)
BIN := space_invaders

.PHONY: all clean run install-deps fetch-sdl-headers

all: $(BIN)

$(BIN): $(OBJ)
	$(CC) -o $@ $^ $(LDFLAGS)

build/%.o: src/%.c include/game.h | build
	$(CC) $(CFLAGS) -c -o $@ $<

build:
	mkdir -p build

run: $(BIN)
	./$(BIN)

clean:
	rm -rf build $(BIN)

install-deps:
	@echo "Debian/Ubuntu: sudo apt install build-essential libsdl2-dev pkg-config"
	@echo "Fedora:        sudo dnf install gcc make SDL2-devel pkgconf-pkg-config"
	@echo "Arch:          sudo pacman -S base-devel sdl2"
	@echo
	@echo "No sudo? try: make fetch-sdl-headers"

# Download SDL2 headers into .deps/ (uses system libSDL2 runtime)
fetch-sdl-headers:
	mkdir -p .deps
	cd .deps && apt-get download libsdl2-dev
	cd .deps && dpkg-deb -x libsdl2-dev_*.deb extracted
	@echo "Headers installed under .deps/extracted — run: make"
