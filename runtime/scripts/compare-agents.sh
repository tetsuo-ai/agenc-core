#!/usr/bin/env bash
# Run the same eval manifest through AgenC, Hermes and OpenCode on one model,
# with the provider key taken from the environment and never placed on argv.
#
#   PROVIDER=anthropic MODEL=claude-sonnet-5 KEY_VAR=ANTHROPIC_API_KEY \
#   AGENC_BIN=/path/to/agenc HERMES_BIN=/path/to/hermes OPENCODE_BIN=/path/to/opencode \
#   AGENC_EVAL_HOME=/abs/isolated/home OUT_DIR=/abs/reports [TAG=sonnet] \
#   runtime/scripts/compare-agents.sh [commands|session|all]
#
# Reports are written as <agent>-<TAG>-commands.json and <agent>-<TAG>-session.json
# (TAG defaults to MODEL) and summarised by scripts/eval-compare-table.mjs.
#
# The isolated AgenC home's config.toml must select PROVIDER/MODEL and the
# reasoning effort; the runner refuses to start a daemon in the default home.
# Hermes and OpenCode get their own isolated homes (HERMES_HOME, XDG_*_HOME)
# under OUT_DIR so nothing touches a developer's real installs.
set -euo pipefail
LANE="${1:-all}"
: "${PROVIDER:?}" "${MODEL:?}" "${KEY_VAR:?}" "${AGENC_BIN:?}" "${HERMES_BIN:?}" "${OPENCODE_BIN:?}" "${AGENC_EVAL_HOME:?}" "${OUT_DIR:?}"
KEY="${!KEY_VAR:?$KEY_VAR is not set}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-node}"
EFFORT="${EFFORT:-medium}"
mkdir -p "$OUT_DIR/hermes-home" "$OUT_DIR/oc-home/config" "$OUT_DIR/oc-home/data" "$OUT_DIR/oc-home/cache"
COMMON=(--executor real --provider "$PROVIDER" --model "$MODEL")
AGENC_CMD="$AGENC_BIN --dangerously-bypass-approvals-and-sandbox -p {prompt}"
HERMES_CMD="$HERMES_BIN chat -Q --yolo --provider $PROVIDER -m $MODEL --reasoning $EFFORT"
OPENCODE_CMD="$OPENCODE_BIN run --auto -m $PROVIDER/$MODEL"
run() { # name manifest report extra-args...
  local name="$1" manifest="$2" report="$3"; shift 3
  echo "=== $name $(date +%T)"
  case "$name" in
    agenc*) env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" "$KEY_VAR=$KEY" AGENC_HOME="$AGENC_EVAL_HOME" \
      "$NODE" "$HERE/scripts/run-agent-eval.mjs" --tasks "$manifest" "${COMMON[@]}" --agent-command "$AGENC_CMD" --agent-name agenc --output "$report" "$@" ;;
    hermes*) env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" TERM=xterm "$KEY_VAR=$KEY" AGENC_HOME="$AGENC_EVAL_HOME" HERMES_HOME="$OUT_DIR/hermes-home" \
      "$NODE" "$HERE/scripts/run-agent-eval.mjs" --tasks "$manifest" "${COMMON[@]}" --agent-command "$HERMES_CMD -q {prompt}" --session-command "$HERMES_CMD {continue} -q {prompt}" --session-continue-arg -c --agent-name hermes --output "$report" "$@" ;;
    opencode*) env -i PATH="$PATH" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" "$KEY_VAR=$KEY" AGENC_HOME="$AGENC_EVAL_HOME" XDG_CONFIG_HOME="$OUT_DIR/oc-home/config" XDG_DATA_HOME="$OUT_DIR/oc-home/data" XDG_CACHE_HOME="$OUT_DIR/oc-home/cache" \
      "$NODE" "$HERE/scripts/run-agent-eval.mjs" --tasks "$manifest" "${COMMON[@]}" --agent-command "$OPENCODE_CMD {prompt}" --session-command "$OPENCODE_CMD {continue} {prompt}" --session-continue-arg --continue --agent-name opencode --output "$report" "$@" ;;
    *) echo "unknown agent: $name" >&2; return 1 ;;
  esac
}
# The runner resolves fixture directories relative to the manifest, so the
# filtered manifests are written next to manifest.json (both are gitignored).
"$NODE" -e '
  const fs = require("node:fs"); const dir = process.argv[1];
  const m = JSON.parse(fs.readFileSync(dir + "/manifest.json", "utf8"));
  const write = (name, keep) => fs.writeFileSync(dir + "/" + name, JSON.stringify({ ...m, benchmark: m.benchmark + "-" + name.replace(/^manifest-|\.json$/g, ""), tasks: m.tasks.filter(keep) }, null, 2) + "\n");
  write("manifest-commands.json", (t) => t.kind !== "session");
  write("manifest-session.json", (t) => t.kind === "session");
' "$HERE/eval/tasks"
TAG="${TAG:-$MODEL}"
if [[ "$LANE" == "commands" || "$LANE" == "all" ]]; then
  for a in agenc hermes opencode; do run "$a commands" "$HERE/eval/tasks/manifest-commands.json" "$OUT_DIR/$a-$TAG-commands.json"; done
fi
if [[ "$LANE" == "session" || "$LANE" == "all" ]]; then
  for a in agenc hermes opencode; do run "$a session" "$HERE/eval/tasks/manifest-session.json" "$OUT_DIR/$a-$TAG-session.json" --timeout-ms 1800000; done
fi
"$NODE" "$HERE/scripts/eval-compare-table.mjs" "$OUT_DIR" "$TAG"
