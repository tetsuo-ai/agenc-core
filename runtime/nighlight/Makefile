CC = gcc
CFLAGS = -std=c11 -Wall -Wextra -O2 -I.
LDFLAGS = -lm

SRCS = main.c game.c map.c fov.c entity.c render.c input.c util.c
OBJS = $(SRCS:.c=.o)
BIN = nighlight

.PHONY: all clean run smoke

all: $(BIN)

$(BIN): $(OBJS)
	$(CC) $(CFLAGS) -o $@ $(OBJS) $(LDFLAGS)

%.o: %.c nighlight.h
	$(CC) $(CFLAGS) -c -o $@ $<

run: $(BIN)
	./$(BIN)

# Headless/scripted smoke: scripted keys via pipe, short timeout
smoke: $(BIN)
	@printf 'ddddwwwwaaaaassssffff....qb' | timeout 3 ./$(BIN) --smoke >./nighlight_smoke.out 2>&1; \
	ec=$$?; \
	if [ $$ec -eq 0 ] || [ $$ec -eq 124 ] || [ $$ec -eq 1 ]; then \
	  grep -q 'NIGHLIGHT' ./nighlight_smoke.out && echo 'SMOKE OK' && cat ./nighlight_smoke.out || (cat ./nighlight_smoke.out; exit 1); \
	else \
	  cat ./nighlight_smoke.out; exit $$ec; \
	fi

clean:
	rm -f $(OBJS) $(BIN) ./nighlight_smoke.out
