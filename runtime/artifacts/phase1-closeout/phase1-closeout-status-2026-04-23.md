# Phase 1 Closeout Status - 2026-04-23

## Completed in this pass

### Runtime validation

- `npm run validate:runtime` passed from `/Users/tetsuoarena/agenc-umbrella/agenc-core`
- Note: the first attempt hit a flaky WebChat continuity test timeout, but the isolated test passed and the full validation rerun passed cleanly.

### Devnet soak evidence

- TUI soak artifact: [`devnet-soak-tui.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/devnet-soak-tui.json)
  - `overallPassed: true`
  - `3 / 3` TUI iterations completed
  - RPC `429` counts by run: `86`, `90`, `83`
- Mixed/plain soak artifact: [`devnet-soak-both.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/devnet-soak-both.json)
  - `overallPassed: true`
  - `plain#1`, `tui#1`, `plain#2`, `tui#2` all completed
  - Plain runs saw `0` RPC `429`s; TUI runs saw `55` and `53`

## Code hardening applied during the pass

These changes were needed to turn the devnet soak from a one-off success into a repeatable result under real `429` pressure:

- [`runtime/src/cli/marketplace-cli.ts`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/src/cli/marketplace-cli.ts)
  - tightened `market.skills.detail` so purchase-visibility lookup failures no longer get silently swallowed
  - this lets RPC-limit failures surface as real command failures and be retried by the soak harness
- [`runtime/src/cli/marketplace-cli.skill-detail.test.ts`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/src/cli/marketplace-cli.skill-detail.test.ts)
  - added regression coverage for the `market.skills.detail` purchase-visibility path
- [`scripts/marketplace-tui-devnet-smoke.ts`](/Users/tetsuoarena/agenc-umbrella/agenc-core/scripts/marketplace-tui-devnet-smoke.ts)
  - added direct CLI fallback for TUI reputation stake
  - added direct CLI fallback for TUI reputation delegation
  - widened skill purchase/rating visibility windows under load
  - added a skill-purchase visibility refresh path that retries through direct CLI purchase before failing

## Host-side evidence gathered after the initial pass

### Runtime host access

Actual runtime host reached:

- `root@165.227.193.85`
- hostname: `cleanproof-xyz`
- Docker present: `/usr/bin/docker`
- Docker version: `28.2.2`

### Sandbox fleet drill on the actual runtime host

Host artifacts copied back locally:

- baseline pass: [`host/sandbox-fleet-baseline-host.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/host/sandbox-fleet-baseline-host.json)
- documented higher-pressure attempt: [`host/sandbox-fleet-pressure-host.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/host/sandbox-fleet-pressure-host.json)
- supported-capacity rerun: [`host/sandbox-fleet-supported-host.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/host/sandbox-fleet-supported-host.json)

Current status:

- baseline host drill passed
- supported-capacity host drill (`8 sandboxes x 3 jobs x 2 waves`) passed
- the documented higher-pressure profile (`8 x 3 x 3`) failed on wave 3 with:
  - `system_sandbox.blocked`
  - `Too many sandbox jobs are already tracked`
  - `maxJobs: 64`

Interpretation:

- the sandbox fleet drill has now been executed on the real runtime host class
- the host is healthy at baseline and a meaningful supported-capacity profile
- there is still a real capacity ceiling at `64` tracked sandbox jobs that needs either:
  - an explicit launch-limit signoff, or
  - a fix plus re-drill of the documented higher-pressure profile

### Operator live drill on the actual runtime host

Artifacts:

- host JSON: [`host/operator-live-drill-host.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/host/operator-live-drill-host.json)
- host note: [`host/operator-live-drill-host.md`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/host/operator-live-drill-host.md)
- local validation run of the same harness: [`operator-live-drill-local.json`](/Users/tetsuoarena/agenc-umbrella/agenc-core/runtime/artifacts/phase1-closeout/operator-live-drill-local.json)

What passed on-host:

- global pause
- per-job-type disable
- quota / rate-limit denial and restore
- compiler version rollback control
- dependency fail-closed denial and restore
- synthetic policy-failure and domain-denial alert emission

What is still blocked:

- real alert routing to pager / Slack / incident room
- human acknowledgement timing evidence
- real on-call response evidence

Interpretation:

- we now have real runtime-host control-plane evidence for the operator drill itself
- however, the production-only parts of the drill remain incomplete because no real alert destination or human acknowledgement path was discoverable on this host during the drill
- this means the operator live drill is **partially complete, but not closed**

## Remaining blockers

### Sandbox capacity signoff or fix

- The runtime host has a reproducible `64` tracked-job ceiling on the documented higher-pressure sandbox profile.
- Phase 1 closeout still needs either:
  - a recorded decision that the supported-capacity profile is the launch envelope, or
  - a runtime fix that raises the ceiling and a green re-run of the higher-pressure artifact.

### Production-only alert routing and on-call evidence

- The drill harness proved synthetic alert emission on the actual runtime host.
- It did **not** prove that alerts reach a real human destination.
- Phase 1 still needs:
  - one real configured alert destination
  - receipt timestamp
  - acknowledgement timestamp
  - an explicit first-response action from the on-call/operator side

## Bottom line

- The Phase 1 devnet validation lane is green in both required soak artifacts.
- The code is materially more resilient to real devnet RPC-rate-limit behavior than it was at the start of this pass.
- The sandbox fleet drill and operator control drill are now executed on the actual runtime host environment.
- Phase 1 closeout is **still not fully complete** because:
  - the documented higher-pressure sandbox profile exposed a real `64` tracked-job ceiling that still needs a launch decision or a fix, and
  - production-only alert routing / on-call acknowledgement evidence is still missing.
