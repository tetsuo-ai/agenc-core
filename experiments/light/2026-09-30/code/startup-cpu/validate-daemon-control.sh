#!/bin/bash
set -euo pipefail
expected=09506769e70269d451716d64ffa02fa4917e993e
cd /work/core-converge-daemoncontrol
test "$(git rev-parse HEAD)" = "$expected"
test -z "$(git status --porcelain)"
npm run typecheck
cd runtime
node scripts/run-hermetic-vitest.mjs run \
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
  --maxWorkers=2 --reporter=dot --reporter=json \
  --outputFile=/work/analysis/daemon-control-linux-tests.json
