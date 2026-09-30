#!/usr/bin/env bash
# Disjoint Linux regression group after the initial64-file gate closes.
set -euo pipefail
ROOT=/home/paul/claude-agenc-work/light-final-20260930-xI3Mf6
test "$(id -u)" = 1000
test -f "$ROOT/completed"
test ! -e "$ROOT/supplement.started"
test -z "$(docker ps -q)"
test "$(df -B1 --output=avail "$ROOT" | tail -1)" -gt 21474836480
exec 9> /home/paul/claude-agenc-work/locks/light-final-serial
flock -n 9
(set -o noclobber; date -u +%FT%TZ > "$ROOT/supplement.started")
NAME=light-final-20260930-xI3Mf6-supplement
set +e
timeout --signal=TERM --kill-after=30s 1200s docker run --init \
 --name "$NAME" --user 1000:1000 --network none \
 --memory=8g --memory-swap=8g --cpus=2 --pids-limit=512 \
 --cap-drop=ALL --security-opt=no-new-privileges \
 -v "$ROOT:/gate" -w /gate/source/runtime \
 -e HOME=/gate/home -e TMPDIR=/gate/tmp -e CI=1 -e TZ=UTC -e LANG=C.UTF-8 \
 sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271 \
 node scripts/run-hermetic-vitest.mjs --require-zero-skips run \
 tests/durability/failure-matrix.acceptance.test.ts \
 tests/plugins/plugin-settings.test.ts \
 tests/browser/manager-navigation-failure.test.ts \
 tests/session/session-fd-leaks.test.ts \
 tests/agents/workflow-handoff-store.test.ts \
 tests/services/compact/source-node-transaction-review.test.ts \
 --maxWorkers=1 --no-file-parallelism --reporter=dot \
 > "$ROOT/logs/supplement.log" 2>&1
rc=$?
set -e
printf '%s\n' "$rc" > "$ROOT/logs/supplement.exit"
docker inspect --format '{{json .State}}' "$NAME" > "$ROOT/logs/supplement.container.json"
if [ "$(docker inspect --format '{{.State.Running}}' "$NAME")" = true ]; then
 docker stop --time 15 "$NAME" > "$ROOT/logs/supplement.stop.log"
fi
date -u +%FT%TZ > "$ROOT/supplement.finished"
printf 'supplement exit=%s\n' "$rc"
exit "$rc"
