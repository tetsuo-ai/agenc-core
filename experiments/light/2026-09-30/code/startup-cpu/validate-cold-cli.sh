#!/bin/bash
set -euo pipefail
expected=${1:?Explicit frozen commit required}
[[ "$expected" =~ ^[0-9a-f]{40}$ ]] || exit 2
cd /work/core-converge-coldcli
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain)"
npm run typecheck
cd runtime
node scripts/run-hermetic-vitest.mjs run \
  tests/bin/agenc.test.ts \
  tests/bin/agenc.user-prompt-submit.test.ts \
  tests/bin/agenc.deferred-input.test.ts \
  tests/bin/agenc.deferred-workflow.test.ts \
  tests/bin/agenc.daemon-only.test.ts \
  tests/bin/agenc.cli-branch.test.ts \
  tests/bin/local-turn-lazy.test.ts \
  tests/bin/cli-output-drain.test.ts \
  tests/bin/project-trust-preflight.test.ts \
  tests/bin/startup-selection.test.ts \
  tests/bin/resume-session.test.ts \
  tests/prompts/system-prompt.test.ts \
  tests/prompts/system-prompt-authority.architecture.test.ts \
  tests/commands/session-compact-context.test.ts \
  tests/app-server/daemon-control-boundary.test.ts \
  tests/app-server/daemon-control-compatibility.test.ts \
  tests/app-server/daemon-cli.contract.test.ts \
  tests/app-server/daemon-autostart.contract.test.ts \
  tests/app-server/daemon-control-upgrade.contract.test.ts \
  tests/app-server/daemon-startup-guard.test.ts \
  tests/app-server/daemon-instance-identity.contract.test.ts \
  tests/app-server/daemon-runtime-info.contract.test.ts \
  tests/app-server/daemon-shutdown-liveness.contract.test.ts \
  tests/app-server/daemon-request-policy.cli.contract.test.ts \
  tests/bin/agenc-main-daemon-audit.test.ts \
  tests/bin/agenc-help.test.ts \
  tests/bin/daemon-proxy-cli.test.ts \
  tests/bin/onboard-cli.test.ts \
  tests/bin/agenc-main-recovery-operator.test.ts \
  tests/bin/headless-cli-io.test.ts \
  tests/bootstrap/node-env.test.ts \
  tests/app-server/daemon-working-directory.test.ts \
  tests/app-server/daemon-spawn-stderr.test.ts \
  tests/app-server/daemon-cli.heap-and-log.test.ts \
  tests/app-server/transport-auth.contract.test.ts \
  tests/app-server/unix-socket-transport.contract.test.ts \
  tests/app-server/windows-named-pipe-fixture.contract.test.ts \
  tests/mcp/server/start.test.ts \
  tests/session/mcp-startup.test.ts \
  tests/app-server/startup-session-restores.test.ts \
  tests/app-server/daemon-workflow-authority.test.ts \
  tests/routines/recovery.test.ts \
  tests/app-server/agent-lifecycle-stop-ownership.contract.test.ts \
  tests/session/session-fd-leaks.test.ts \
  tests/bin/cli-cold-boundary.test.ts \
  tests/bin/mcp-cli.test.ts \
  tests/bin/mcp-cli-management.test.ts \
  tests/bin/doctor-cli.test.ts \
  tests/bin/trajectories-cli.test.ts \
  tests/bin/slash.test.ts \
  tests/skills/skills-cli.test.ts \
  tests/skills/skill-candidates.test.ts \
  tests/session/trajectory-curate.test.ts \
  tests/utils/gracefulShutdown.test.ts \
  tests/utils/retired-print-relays.architecture.test.ts \
  --maxWorkers=2 --reporter=dot --reporter=json \
  --outputFile=/work/analysis/cold-cli-linux-tests.json
