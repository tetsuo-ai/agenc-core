#!/usr/bin/env bash
# One fresh Linux correctness gate. No paid calls or performance claims.
set -euo pipefail
ROOT=${1:?absolute fresh gate root}
case "$ROOT" in /home/paul/claude-agenc-work/light-final-20260930-*) ;; *) exit 64;; esac
test "$(id -u)" = 1000
test ! -e "$ROOT/started"
test -d "$ROOT/source/runtime"
test "$(df -B1 --output=avail "$ROOT" | tail -1)" -gt 21474836480
test -z "$(docker ps -q)"
mkdir -p "$ROOT/home" "$ROOT/tmp" "$ROOT/npm-cache" "$ROOT/logs"
(set -o noclobber; date -u +%FT%TZ > "$ROOT/started")
IMAGE=sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271
COMMIT=38d63e586a92c4da8b1e51b31d46f74ee359a55a
NAME=$(basename "$ROOT")
exec 9> /home/paul/claude-agenc-work/locks/light-final-serial
flock -n 9
run_phase() {
  local phase=$1 network=$2; shift 2
  date -u +%FT%TZ > "$ROOT/logs/$phase.started"
  set +e
  timeout --signal=TERM --kill-after=30s 1200s docker run --init \
    --name "$NAME-$phase" --user 1000:1000 --network "$network" \
    --memory=8g --memory-swap=8g --cpus=2 --pids-limit=512 \
    --cap-drop=ALL --security-opt=no-new-privileges \
    -v "$ROOT:/gate" -w /gate/source \
    -e HOME=/gate/home -e TMPDIR=/gate/tmp -e CI=1 -e TZ=UTC -e LANG=C.UTF-8 \
    -e npm_config_cache=/gate/npm-cache -e npm_config_registry=https://registry.npmjs.org/ \
    -e npm_config_userconfig=/gate/home/empty.npmrc -e npm_config_audit=false -e npm_config_fund=false \
    -e npm_config_strict_allow_scripts=true -e AGENC_SKIP_POSTINSTALL=1 \
    -e AGENC_BUILD_COMMIT="$COMMIT" -e SOURCE_DATE_EPOCH=1790767058 \
    -e AGENC_BUILD_TIME=2026-09-30T11:17:38.000Z \
    "$IMAGE" "$@" > "$ROOT/logs/$phase.log" 2>&1
  local rc=$?
  set -e
  printf '%s\n' "$rc" > "$ROOT/logs/$phase.exit"
  docker inspect --format '{{json .State}}' "$NAME-$phase" > "$ROOT/logs/$phase.container.json"
  printf '%s phase=%s exit=%s\n' "$(date -u +%FT%TZ)" "$phase" "$rc"
  if [ "$rc" -ne 0 ]; then
    # Do not touch any unowned process. Retain container and all evidence.
    if [ "$(docker inspect --format '{{.State.Running}}' "$NAME-$phase")" = true ]; then
      docker stop --time 15 "$NAME-$phase" > "$ROOT/logs/$phase.stop.log"
    fi
    return "$rc"
  fi
}
run_phase install bridge bash -lc 'node --version; npx --yes npm@11.17.0 --version; npx --yes npm@11.17.0 ci --prefer-offline --no-audit --no-fund --loglevel=error'
run_phase typecheck none bash -lc 'npx --offline --yes npm@11.17.0 run typecheck --workspace=@tetsuo-ai/runtime'
run_phase build none bash -lc 'npx --offline --yes npm@11.17.0 run build'
run_phase focused-tests none bash -lc 'cd runtime; node scripts/run-hermetic-vitest.mjs --require-zero-skips run \
 tests/bin/bootstrap.prepared-sampling.test.ts \
 tests/app-server/background-agent-runner.prepared-sampling.test.ts \
 tests/bin/bootstrap-services.test.ts tests/bin/bootstrap.session-ingress.test.ts \
 tests/session/bootstrap.test.ts \
 tests/app-server/background-agent-runner.bounded-ordered.test.ts \
 tests/app-server/background-agent-runner.stop-mapping.test.ts \
 tests/prompts/attachments \
 tests/session/prepared-sampling-evidence.test.ts \
 tests/session/run-turn.prepared-sampling-evidence.test.ts \
 tests/session/run-turn.advisory-compaction.test.ts \
 tests/budget/admitted-model-call.test.ts tests/budget/admitted-boundaries.integration.test.ts \
 tests/llm/providers/openai tests/llm/wire/responses-openai \
 tests/llm/client-session.test.ts tests/llm/client-session-body-lifetime.test.ts \
 tests/llm/client-session-stream-close.test.ts tests/llm/client-session.retry-after.test.ts \
 tests/llm/providers/deepseek/provider.test.ts tests/llm/wire/incomplete-tool-calls.test.ts \
 tests/recovery/max-output-tokens.test.ts tests/phases/stream-model.test.ts \
 tests/session/run-turn.truncated-tool-recovery.test.ts tests/session/light-reasoning-policy.test.ts \
 tests/session/run-turn.responses-terminal-safety.test.ts tests/session/run-turn.light-write-admission.test.ts \
 tests/agents/jobs/job-orchestrator.test.ts \
 --maxWorkers=1 --no-file-parallelism --reporter=dot'
date -u +%FT%TZ > "$ROOT/completed"
