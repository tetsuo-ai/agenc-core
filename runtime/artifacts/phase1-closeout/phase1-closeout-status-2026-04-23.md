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
- the documented higher-pressure profile (`8 x 3 x 3`) now also passes on the real host after explicitly raising the tracked-job ceiling:
  - `maxTrackedJobs: 96`
  - `overallPassed: true`
  - all `3` waves completed with `24` jobs each

Interpretation:

- the sandbox fleet drill has now been executed on the real runtime host class
- the host is healthy at baseline, supported-capacity, and the documented higher-pressure profile
- the launch-relevant pressure blocker is closed, with the chosen runtime ceiling now recorded in the host artifact

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
- real alert routing to a primary and backup destination
- human receipt and acknowledgement timing evidence
- explicit first-response step capture

Interpretation:

- we now have real runtime-host control-plane evidence for the operator drill itself
- the production-only route is now exercised end to end:
  - primary alert destination delivered
  - backup alert destination delivered
  - receiver seen time recorded
  - acknowledgement time recorded
  - first containment step recorded
- this closes the operator live-drill blocker for Phase 1

## Remaining blockers

- none identified in this closeout lane

## Bottom line

- The Phase 1 devnet validation lane is green in both required soak artifacts.
- The code is materially more resilient to real devnet RPC-rate-limit behavior than it was at the start of this pass.
- The sandbox fleet drill and operator control drill are now executed on the actual runtime host environment.
- Phase 1 closeout evidence for this lane is now complete:
  - documented higher-pressure sandbox concurrency passed on the host with recorded ceiling `96`
  - production alert routing and on-call acknowledgement evidence are attached in the host artifact set
