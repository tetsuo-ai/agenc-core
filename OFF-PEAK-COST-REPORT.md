# Off-peak cost display

Design note (before implementation)

Admission reservations retain each call's `dispatched_at`, provider, model and
settled cost. The incremental observer in `state/admission-usage-snapshot.ts`
already reads these rows; the SQL summary in `state/execution-admission.ts`
also has access to them. Rollout records have event timestamps, but the cost
sidecar and `cost-totals.json` retain aggregate usage, not per-call times.
`session/off-peak-pricing.ts` records the DeepSeek API and three QwenCloud
DeepSeek model schedules. Both charge half off-peak. Chinese holidays and
Ollama Cloud's off-peak hours are not recorded.

Cost surfaces and exports:

- Fullscreen status line: canonical `session_usage.costUsd`, or the sidecar
  fallback, plus a mark based on the current provider and current clock.
- `/cost` (`/stats`): canonical usage, falling back to the sidecar; plain text
  and `CostUsageModal` show totals and model/agent breakdowns.
- `/status`: canonical usage and sidecar summary; retains accounting totals.
- `cost-totals.json`: sidecar session/model/project accounting totals and
  resume baselines; retains its existing format and numbers.
- Print/exit summaries: `CostSidecar.formatTotalCost`, `cost/tracker.ts` and
  the exit hooks; retain accounting totals. SDK result schemas and custom
  status-line hook `total_cost_usd` also retain accounting semantics.
- Desktop/daemon: durable `session_usage` events, session snapshots and
  background-agent terminal usage carry accounting totals. The new optional
  display field can travel with usage events; existing cost fields stay put.

Proposal: derive an optional `billedEstimateUsd` in the read-only usage
observation from settled costs and dispatch times. Apply the recorded 50%
discount only to model calls on eligible routes, never tools, unpriced calls
or fallback prices. Provider-reported charge routes (OpenRouter and Venice)
have no recorded schedule and are not discounted. Missing dispatch times on
eligible priced calls suppress the billed estimate. Show `billed est.` in
the footer, or `peak est.` for older/fallback data, with no current-clock
off-peak mark. Keep `≥` for unpriced usage. `/cost` shows the billed estimate
alongside the accounting total, explicitly describing its peak-rate basis.
No writes to accounting tables, no schema migration, and no changes to cost
sidecar persistence, budget enforcement, task budgets or spend caps.

Result

The footer displays `≥$0.750 billed est.` for two $0.500 peak-accounting calls,
one peak and one off-peak, plus an unpriced call. Accounting remains $1.00;
the current clock does not affect the display. Missing eligible dispatch times
use `peak est.`. Unknown fallback prices remain `price unknown`.

Changed files (paths relative to this worktree)

- `runtime/src/budget/admission-types.ts`: optional observation-only billed estimate.
- `runtime/src/state/admission-usage-snapshot.ts`: per-call savings from dispatch
  times; preserve accounting counters and snapshot equality.
- `runtime/src/state/execution-admission.ts`: the same estimate in the read-only
  SQL summary, including resumed sessions and descendants.
- `runtime/src/session/usage-summary.ts`: validate the optional display field.
- `runtime/src/session/off-peak-pricing.ts`: comments for per-call display use.
- `runtime/src/tui/context/sessionUsageContext.tsx`: carry the display estimate.
- `runtime/src/tui/components/FullscreenLayout.tsx`: billed or explicit peak
  estimate; remove the current-clock mark and timer. Never abbreviate the basis.
- `runtime/src/commands/cost.ts`: accounting total and separate billed estimate.
- `runtime/src/tui/components/v2/CostUsageModal.tsx`: both figures in the modal.
- `runtime/tests/state/admission-usage-projection.test.ts`: eligible routes,
  exclusions, missing times, fallback prices and immutable snapshots.
- `runtime/tests/state/execution-admission-usage.test.ts`: mixed windows, child
  calls, SQL/snapshot agreement, restart and unchanged task-budget counts.
- `runtime/tests/tui/components/FullscreenLayout.usage-indicators.test.tsx`:
  mixed-window regression, unknown prefix, clock independence, labels and layout.
- `runtime/tests/commands/cost.test.ts`: text and modal show both figures.
- `runtime/tests/tui/session-usage-summary.test.ts`: replay and field validation.
- `docs/reference/cli.md`: footer labels, calculation and unchanged exports.
- `docs/reference/slash-commands.md`: `/cost` semantics and limitations.
- `OFF-PEAK-COST-REPORT.md`: design, inventory and verification record.

Verification

Commands ran from this worktree with:

```sh
export PATH=/Users/tetsuoarena/claude-agenc/node/n/versions/node/26.12.1/bin:$PATH
mkdir -p /private/tmp/tt/vt
```

Fail before implementation (exit 1):

```sh
cd runtime && TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run tests/tui/components/FullscreenLayout.usage-indicators.test.tsx -t 'mixes peak and off-peak' --maxWorkers=2
```

The regression expected `billedEstimateUsd` to be `0.75`, but received
`undefined`. After implementation it passes and checks `≥$0.750 billed est.`
at both peak and off-peak current times.

Final targeted run (exit 0, 13 files, 203 tests passed):

```sh
cd runtime && TMPDIR=/private/tmp/tt/vt node scripts/run-hermetic-vitest.mjs run tests/tui/components/FullscreenLayout.usage-indicators.test.tsx tests/tui/components/FullscreenLayout.session-usage.test.tsx tests/tui/components/FullscreenLayout.test.tsx tests/tui/components/FullscreenLayout.render-branches.test.tsx tests/tui/components/FullscreenLayout.coverage2.test.tsx tests/tui/components/FullscreenLayout.wave200-018.coverage.test.tsx tests/state/admission-usage-projection.test.ts tests/state/execution-admission-usage.test.ts tests/state/execution-admission-usage-catch-up.test.ts tests/commands/cost.test.ts tests/session/off-peak-pricing.test.ts tests/session/cost-persistence.test.ts tests/tui/session-usage-summary.test.ts --maxWorkers=2
```

Intermediate runs caught two obsolete layout expectations and a mismatch
between incremental and materialized snapshot signatures. Those were corrected;
the final run includes all affected checks.

The requested typecheck command initially exited 1 before TypeScript ran:

```sh
cd runtime && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test-support.json
```

Node 26 bundles npm 11.20.0, but the repository requires 11.17.0. That requirement
also exists in `origin/main:package.json`. Both TypeScript checks then passed
(exit 0, no TypeScript errors) with the package manager guard bypassed and
offline execution. No dependencies were installed:

```sh
export npm_config_force=true npm_config_offline=true npm_config_update_notifier=false
export npm_config_cache="$PWD/.npm-cache-cost-footer"
cd runtime && npx tsc --noEmit -p tsconfig.json && npx tsc --noEmit -p tsconfig.test-support.json
```

The temporary npm cache was removed afterwards. `git diff --check` passed.
There are no TypeScript errors to classify as pre-existing on origin/main.

Unchanged limitations and separate findings

- Chinese public holidays and Ollama Cloud off-peak hours remain unrecorded.
- `/status`, print/exit summaries, custom status-line hook cost fields,
  Desktop accounting fields and `cost-totals.json` still use accounting totals.
  Some legacy human-readable summaries call these simply “cost”; their labeling
  could still be mistaken for an invoice. They were not changed in this job.
- Native eligible routes currently do not ingest provider-reported charges.
  If that changes, the projection will need charge provenance so it never
  discounts an already-discounted provider charge.
- The SQL summary reads settled model-call timestamps in addition to its
  existing aggregate query; the incremental snapshot path remains cached.
