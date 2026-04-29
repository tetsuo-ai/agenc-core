# Marketplace Mainnet V1 Readiness

This is the launch gate for the first mainnet marketplace cut that runs through
core protocol, runtime, SDK, CLI, TUI, and explorer visibility.

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/549>

## Scope

Included in mainnet v1:

- public task creation
- task discovery/list/detail
- worker claim
- exclusive claim contention
- worker completion
- buyer-facing artifact/result reference through the fixed on-chain result rail
- reviewed-public creator review flow
- dispute open, vote, and resolve
- explorer/indexing visibility for task state changes
- signer, wallet, reward, and mutation-policy controls
- repeated devnet soak runs
- operator controls and incident response evidence

Excluded from mainnet v1:

- Private ZK marketplace tasks
- storefront/no-code checkout
- AgenC Lab/Telegram buyer rails
- rich storefront delivery review UI

Those excluded surfaces can ship after the base protocol marketplace is proven
safe and operable on devnet.

## Required Evidence

Every required lane must have reproducible evidence before mainnet. A lane is
not green just because one lower-level unit test passed.

| Lane | Required Evidence | Gate |
| --- | --- | --- |
| Preflight | RPC reachable, program ID selected, signer policy guard works | Required |
| Public lifecycle | create -> list/detail -> claim -> complete -> final task state | Required |
| Reviewed-public lifecycle | create with creator review -> submit result -> accept/reject/timeout -> settlement | Required |
| Exclusive claim contention | two workers race to claim one exclusive reviewed-public task -> exactly one wins -> loser is rejected cleanly | Required |
| Artifact/result rail | worker submits artifact file or URI -> digest committed in resultData -> reader reconstructs reference | Required |
| Dispute lifecycle | open dispute -> 3 arbiter votes -> resolve -> final task/dispute state | Required |
| Explorer visibility | new/updated PDAs appear in explorer/indexing within expected polling window | Required |
| Signer/wallet safety | reward caps, allowed tools, constraint guards, no unsafe default mutation tools | Required |
| Soak | repeated devnet runs with no unclassified failures | Required |
| Operator controls | pause/disable/rollback/alert acknowledgement evidence on target runtime host | Required |

## Runner

Use the mainnet-v1 devnet gate:

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- --mode all
```

Useful lane commands:

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- --mode preflight
npm run smoke:marketplace:mainnet-v1:devnet -- --mode public
npm run smoke:marketplace:mainnet-v1:devnet -- --mode reviewed-public
npm run smoke:marketplace:mainnet-v1:devnet -- --mode contention
npm run smoke:marketplace:mainnet-v1:devnet -- --mode artifact
npm run smoke:marketplace:mainnet-v1:devnet -- --mode dispute
npm run smoke:marketplace:mainnet-v1:devnet -- --mode explorer
npm run smoke:marketplace:mainnet-v1:devnet -- --mode safety
npm run smoke:marketplace:mainnet-v1:devnet -- --mode soak --iterations 3
npm run smoke:marketplace:mainnet-v1:devnet -- --mode operator
```

The runner writes a JSON evidence artifact under `/tmp` by default. Use
`--artifact <path>` to pin the evidence into a release folder.

`--allow-pending` is only for roadmap discovery. It must not be used for the
final mainnet go/no-go run.

## Live Devnet Environment

The live protocol lanes require funded devnet signers:

```bash
export CREATOR_WALLET=/path/to/creator.json
export WORKER_WALLET=/path/to/worker.json
export WORKER_B_WALLET=/path/to/worker-b.json
export WORKER_WALLETS=/path/to/worker-1.json,/path/to/worker-2.json # optional N-worker contention list
export ARBITER_A_WALLET=/path/to/arbiter-a.json
export ARBITER_B_WALLET=/path/to/arbiter-b.json
export ARBITER_C_WALLET=/path/to/arbiter-c.json
export PROTOCOL_AUTHORITY_WALLET=/path/to/authority.json
export AGENC_RPC_URL=https://api.devnet.solana.com
export AGENC_EXPLORER_URL=https://devnet.agenc.tech
```

Optional:

```bash
export AGENC_PROGRAM_ID=<program-id>
export AGENC_REWARD_LAMPORTS=10000000
export AGENC_MAX_WAIT_SECONDS=300
```

The reviewed-public artifact lane can also be run directly:

```bash
npm run smoke:marketplace:devnet -- --flow reviewed-public-artifact
```

That flow creates a creator-review task, claims it, completes it with
`--artifact-file`, accepts it from the creator side, and asserts that task
detail reconstructs the buyer-facing artifact digest from on-chain `resultData`.
It also checks `tasks.list` visibility after create, claim, and accept.

The explorer lane is stricter than the CLI visibility check. It now requires a
real explorer URL and proves the explorer itself can read the completed task from
its HTTP read model:

```bash
AGENC_EXPLORER_URL=https://devnet.agenc.tech \
npm run smoke:marketplace:mainnet-v1:devnet -- --mode explorer
```

The gate creates a reviewed-public artifact task, waits for the public explorer
to index it, then checks `/healthz`, `/api/bootstrap`, `/api/tasks/:taskPda`,
and `/api/tasks?q=<taskPda>`. It fails if the explorer points at a different
program ID, cannot render the completed task detail, or cannot find the task in
list/search output inside the polling window. This keeps explorer readiness out
of the storefront and tied to the same protocol read model operators use.

The exclusive claim contention lane can also be run directly:

```bash
npm run smoke:marketplace:devnet -- --flow claim-contention
```

That flow creates an exclusive creator-review task with `maxWorkers=1`, submits
concurrent worker claims from distinct agents, asserts exactly one claim wins,
asserts every other worker is rejected cleanly, and verifies the task is visible
as `in_progress` with `currentWorkers=1`. By default it uses `WORKER_WALLET`
plus `WORKER_B_WALLET`. Set `WORKER_WALLETS` to a comma-separated list to test
larger contention, for example 10 workers.

The operator lane runs:

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- --mode operator
```

That wraps `scripts/compiled-job-phase1-operator-drill.ts` and only passes when
the generated host-drill artifact has `overallPassed: true`. A dry local run
without real alert routing or on-call acknowledgement is expected to fail the
mainnet gate.

## Supporting Drills

The mainnet-v1 runner is the top-level gate. These scripts remain useful for
isolated investigation:

```bash
npm run smoke:marketplace:devnet
npm run smoke:marketplace:tui:devnet
npm run smoke:marketplace:hardening:devnet
npm run drill:sandbox:fleet
npm run drill:compiled-job:operator-live
```

## Go/No-Go Rule

Go:

- every required lane returns `pass`
- soak evidence is attached
- operator live-drill evidence is attached
- no unresolved blocker issue remains for the included launch scope

No-go:

- any required lane returns `fail`
- any required lane returns `pending`
- evidence requires storefront, Private ZK, or another excluded surface to make
  the base marketplace lifecycle work
- operator controls cannot be executed in the target runtime environment
