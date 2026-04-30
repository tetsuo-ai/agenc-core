# Marketplace Mainnet Canary Runbook

This runbook is the operator plan for the first constrained AgenC Marketplace
mainnet canary. It turns the devnet readiness evidence into a narrow mainnet
launch procedure.

Tracking issue: <https://github.com/tetsuo-ai/agenc-core/issues/549>

## Launch Boundary

This is a GO only for a low-value supervised canary:

- Exclusive tasks only.
- CreatorReview reviewed-public settlement only.
- Native SOL rewards only.
- Maximum reward: `50_000_000` lamports (`0.05 SOL`) per task.
- First task reward: `10_000_000` lamports (`0.01 SOL`).
- Total outstanding canary escrow cap: `1 SOL`.
- Required job-spec verification in official runtime/CLI flows.
- Mandatory signer policy for hosted mutation tools.
- Real explorer HTTP monitoring.
- Telegram operator alerting with human acknowledgement.
- Operator-supervised disputes only.

This does not authorize broad public launch. Keep the following disabled:

- Private ZK marketplace tasks.
- Storefront/no-code checkout.
- AgenC Lab and Telegram user bot buyer rails.
- SPL/token rewards.
- Public auto-settle artifact tasks.
- Collaborative, Competitive, and BidExclusive task types.
- ValidatorQuorum and ExternalAttestation validation modes.
- Remote job-spec resolution by default.
- High-value rewards.
- Unsupervised disputes.
- Governance, staking/delegation, skill purchase/rating mutation tools.

## Required Pins

Record the exact values before launch:

```bash
export AGENC_RPC_URL="<mainnet RPC URL>"
export AGENC_RPC_URL_BACKUP="<backup mainnet RPC URL>"
export AGENC_PROGRAM_ID="<final mainnet program id>"
export AGENC_EXPLORER_URL="<mainnet explorer base URL>"

export CREATOR_WALLET="/secure/mainnet/creator-hot.json"
export WORKER_WALLET="/secure/mainnet/worker-hot.json"
export WORKER_B_WALLET="/secure/mainnet/worker-b-hot.json"
export ARBITER_A_WALLET="/secure/mainnet/arbiter-a-hot.json"
export ARBITER_B_WALLET="/secure/mainnet/arbiter-b-hot.json"
export ARBITER_C_WALLET="/secure/mainnet/arbiter-c-hot.json"
export PROTOCOL_AUTHORITY_WALLET="/secure/mainnet/protocol-authority.json"

export AGENC_REWARD_LAMPORTS="10000000"
export AGENC_MAX_REWARD_LAMPORTS="50000000"
export AGENC_TOTAL_ESCROW_CAP_LAMPORTS="1000000000"
export AGENC_REVIEW_WINDOW_SECS="86400"
export AGENC_CLAIM_JOB_SPEC_VERIFICATION="required"
export AGENC_ALLOW_REMOTE_JOB_SPEC_RESOLUTION="false"

export AGENC_CANARY_DISABLED_TASK_TYPE_MASK="14"
export AGENC_EMERGENCY_DISABLED_TASK_TYPE_MASK="15"

export EVIDENCE_DIR="./evidence/mainnet-canary-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$EVIDENCE_DIR"
```

Deployment order is a hard gate:

1. Deploy protocol with launch controls from `agenc-protocol#35`.
2. Deploy runtime/CLI/explorer with `agenc-core#556` and `agenc-core#557`.
3. Deploy explorer with the HTTP drill support from `agenc-core#555`.
4. Verify explorer bootstrap reports the final mainnet program ID.

If runtime/CLI/explorer point at an older protocol account layout, this is
NO-GO.

## Task-Type Mask

The canary enables only `Exclusive`.

| Task type | Index | Canary state |
| --- | ---: | --- |
| Exclusive | 0 | enabled |
| Collaborative | 1 | disabled |
| Competitive | 2 | disabled |
| BidExclusive | 3 | disabled |

Normal canary open state:

```text
disabled_task_type_mask = 0b1110 = 14
protocol_paused = false
```

Emergency state:

```text
disabled_task_type_mask = 0b1111 = 15
protocol_paused = true
```

## Signer Policy Shape

Use role-specific signer policies. Do not use one broad policy for all wallets.

Creator policy before task creation:

```json
{
  "allowedTools": [
    "agenc.createTask",
    "agenc.configureTaskValidation",
    "agenc.acceptTaskResult",
    "agenc.rejectTaskResult",
    "agenc.initiateDispute",
    "agenc.cancelDispute"
  ],
  "allowedProgramIds": ["<MAINNET_PROGRAM_ID>"],
  "allowedRewardMints": ["SOL"],
  "maxRewardLamports": "50000000",
  "maxStakeLamports": "0",
  "allowedConstraintHashes": [],
  "allowedTemplateIds": ["mainnet-canary-reviewed-public-v1"]
}
```

After task creation, scope policies to known PDAs and hashes:

```json
{
  "allowedTools": [
    "agenc.configureTaskValidation",
    "agenc.acceptTaskResult",
    "agenc.rejectTaskResult",
    "agenc.initiateDispute",
    "agenc.cancelDispute"
  ],
  "allowedProgramIds": ["<MAINNET_PROGRAM_ID>"],
  "allowedTaskPdas": ["<TASK_PDA>"],
  "allowedJobSpecHashes": ["<JOB_SPEC_HASH_HEX>"],
  "allowedRewardMints": ["SOL"],
  "maxRewardLamports": "50000000",
  "maxStakeLamports": "0"
}
```

Worker policy:

```json
{
  "allowedTools": [
    "agenc.claimTask",
    "agenc.completeTask",
    "agenc.initiateDispute"
  ],
  "allowedProgramIds": ["<MAINNET_PROGRAM_ID>"],
  "allowedTaskPdas": ["<TASK_PDA>"],
  "allowedJobSpecHashes": ["<JOB_SPEC_HASH_HEX>"],
  "allowedRewardMints": ["SOL"],
  "maxRewardLamports": "50000000",
  "maxStakeLamports": "0"
}
```

Arbiter policy:

```json
{
  "allowedTools": ["agenc.voteDispute"],
  "allowedProgramIds": ["<MAINNET_PROGRAM_ID>"],
  "allowedDisputePdas": ["<DISPUTE_PDA>"],
  "allowedRewardMints": ["SOL"],
  "maxRewardLamports": "0",
  "maxStakeLamports": "0"
}
```

Resolver/operator policy:

```json
{
  "allowedTools": [
    "agenc.resolveDispute",
    "agenc.expireDispute",
    "agenc.applyDisputeSlash"
  ],
  "allowedProgramIds": ["<MAINNET_PROGRAM_ID>"],
  "allowedTaskPdas": ["<TASK_PDA>"],
  "allowedDisputePdas": ["<DISPUTE_PDA>"],
  "allowedRewardMints": ["SOL"],
  "maxRewardLamports": "50000000",
  "maxStakeLamports": "0"
}
```

Hard signer-policy gates:

- Read-only tools may load without signer policy.
- Hosted mutation tools must not load without signer policy.
- Missing policy must return `POLICY_REQUIRED`.
- Above-cap rewards must be denied.
- Non-SOL reward mints must be denied.
- Unexpected writable account metas must be denied when the policy pins metas.

## Wallet Funding Caps

Use low-balance hot wallets:

| Wallet | Purpose | Cap |
| --- | --- | ---: |
| Creator hot wallet | create/accept/reject canary tasks | `0.25 SOL` |
| Worker hot wallet | claim/submit canary work | `0.10 SOL` |
| Worker B hot wallet | contention loser / backup worker | `0.10 SOL` |
| Arbiter A/B/C hot wallets | dispute votes only | `0.05 SOL` each |
| Resolver/operator wallet | dispute resolution and launch controls | `0.10 SOL` |
| Protocol authority/multisig | launch controls only | offline except control updates |

HOLD if any hot wallet exceeds its cap.

## Pre-Launch Checklist

Record this evidence before opening canary intake:

```bash
git -C agenc-protocol rev-parse HEAD | tee "$EVIDENCE_DIR/protocol-sha.txt"
git -C agenc-core rev-parse HEAD | tee "$EVIDENCE_DIR/core-sha.txt"
git -C agenc-public-explorer rev-parse HEAD | tee "$EVIDENCE_DIR/explorer-sha.txt"
node --version | tee "$EVIDENCE_DIR/node-version.txt"
npm --version | tee "$EVIDENCE_DIR/npm-version.txt"
```

Check explorer:

```bash
curl -fsS "$AGENC_EXPLORER_URL/healthz" \
  | tee "$EVIDENCE_DIR/00-explorer-healthz.json"

curl -fsS "$AGENC_EXPLORER_URL/api/bootstrap" \
  | tee "$EVIDENCE_DIR/00-explorer-bootstrap.json"
```

Check operator alerting by sending a real Telegram alert and recording:

- Telegram message ID.
- Acknowledging user.
- Ack timestamp.
- First response step.

## Launch Sequence

### 1. Freeze before open

Set global pause and disable every task type.

```bash
$AGENC_ADMIN update-launch-controls \
  --rpc "$AGENC_RPC_URL" \
  --program-id "$AGENC_PROGRAM_ID" \
  --authority "$PROTOCOL_AUTHORITY_WALLET" \
  --paused true \
  --disabled-task-type-mask 15 \
  --evidence "$EVIDENCE_DIR/01-freeze.json"
```

### 2. Run preflight and safety lanes

Use the checked-in readiness runner. Do not use `--allow-pending`.

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode preflight \
  --artifact "$EVIDENCE_DIR/02-preflight.json"

npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode safety \
  --artifact "$EVIDENCE_DIR/02-safety.json"

npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode operator \
  --artifact "$EVIDENCE_DIR/02-operator.json"
```

### 3. Open Exclusive-only canary

```bash
$AGENC_ADMIN update-launch-controls \
  --rpc "$AGENC_RPC_URL" \
  --program-id "$AGENC_PROGRAM_ID" \
  --authority "$PROTOCOL_AUTHORITY_WALLET" \
  --paused false \
  --disabled-task-type-mask 14 \
  --evidence "$EVIDENCE_DIR/03-open-exclusive-only.json"
```

### 4. Run first reviewed-public task

```bash
export AGENC_REWARD_LAMPORTS="10000000"

npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode reviewed-public \
  --artifact "$EVIDENCE_DIR/04-first-reviewed-public.json" \
  --child-max-wait-seconds 300
```

Acceptance criteria:

- `create_task` tx recorded.
- `set_task_job_spec` tx recorded.
- `configure_task_validation` tx recorded.
- task type is `Exclusive`.
- validation mode is `CreatorReview`.
- reward mint is native SOL/null.
- reward is not above `50_000_000` lamports.
- job spec hash is present and verified.
- exactly one claim exists.
- `submit_task_result` tx recorded.
- artifact SHA-256 recorded.
- task enters pending validation before creator acceptance.
- no worker payout occurs before creator acceptance.
- `accept_task_result` tx recorded.
- final settlement happens once.
- duplicate accept/complete is rejected or idempotently refused.
- explorer detail and list/search show final state.

### 5. Run explorer confirmation

```bash
npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode explorer \
  --explorer-url "$AGENC_EXPLORER_URL" \
  --explorer-wait-seconds 180 \
  --explorer-poll-ms 5000 \
  --artifact "$EVIDENCE_DIR/05-explorer.json"
```

### 6. Run tiny contention test

```bash
export AGENC_REWARD_LAMPORTS="5000000"
export WORKER_WALLETS="$WORKER_WALLET,$WORKER_B_WALLET"

npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode contention \
  --artifact "$EVIDENCE_DIR/06-contention.json" \
  --child-max-wait-seconds 300
```

Expected result:

- exactly one winner.
- every other claim rejects cleanly.
- final task state has `currentWorkers=1` and `maxWorkers=1`.

### 7. Optional supervised dispute

Run only after the first lifecycle, explorer confirmation, and contention pass.

```bash
export AGENC_REWARD_LAMPORTS="5000000"

npm run smoke:marketplace:mainnet-v1:devnet -- \
  --mode dispute \
  --artifact "$EVIDENCE_DIR/07-dispute.json" \
  --child-max-wait-seconds 300
```

If the voting deadline requires waiting, schedule a one-shot resume job with an
explicit `PATH` that includes the Node binary location. Record the schedule,
deadline, resume log, Telegram alert, and GitHub evidence comment.

## Monitoring Alerts

Page immediately and require human acknowledgement for:

- program ID mismatch between runtime, explorer, and protocol.
- hosted mutation tools running without signer policy.
- official reward above `50_000_000` lamports.
- official token/SPL reward.
- official task type not `Exclusive`.
- official validation mode not `CreatorReview`.
- artifact settlement without creator review.
- escrow mismatch.
- duplicate settlement.
- explorer cannot see task within 180 seconds.
- dispute deadline or `voting_deadline + 120s` grace window approaching.
- direct `claim_task` on an official canary task outside the verified path.

Warn, hold intake, and investigate for:

- pending review at 50%, 75%, or deadline.
- explorer lag above 60 seconds.
- RPC error rate above 5% over 10 minutes.
- hot wallet over cap.
- total outstanding escrow above `1 SOL`.
- unsupported direct high-value/token task against the public program.

## Rollback

Global emergency pause:

```bash
$AGENC_ADMIN update-launch-controls \
  --rpc "$AGENC_RPC_URL" \
  --program-id "$AGENC_PROGRAM_ID" \
  --authority "$PROTOCOL_AUTHORITY_WALLET" \
  --paused true \
  --disabled-task-type-mask 15 \
  --evidence "$EVIDENCE_DIR/emergency-pause.json"
```

Disable all new task intake while allowing documented cleanup:

```bash
$AGENC_ADMIN update-launch-controls \
  --rpc "$AGENC_RPC_URL" \
  --program-id "$AGENC_PROGRAM_ID" \
  --authority "$PROTOCOL_AUTHORITY_WALLET" \
  --paused false \
  --disabled-task-type-mask 15 \
  --evidence "$EVIDENCE_DIR/disable-all-task-types.json"
```

Return to Exclusive-only after root cause is signed off:

```bash
$AGENC_ADMIN update-launch-controls \
  --rpc "$AGENC_RPC_URL" \
  --program-id "$AGENC_PROGRAM_ID" \
  --authority "$PROTOCOL_AUTHORITY_WALLET" \
  --paused false \
  --disabled-task-type-mask 14 \
  --evidence "$EVIDENCE_DIR/resume-exclusive-only.json"
```

## Go / Hold / No-Go

GO only if:

- final program ID matches runtime, CLI, explorer, signer policy, and monitor config.
- protocol is `#35` compatible.
- runtime/CLI are `#556`/`#557` compatible.
- explorer is `#555` compatible.
- `disabled_task_type_mask=14` during active canary windows.
- signer-policy denial tests pass.
- first reviewed-public lifecycle passes.
- no payout occurs before creator acceptance.
- explorer detail and list/search see the task.
- Telegram alert and acknowledgement are captured.
- rollback command has been tested.

HOLD if:

- evidence is incomplete.
- explorer lag exceeds the polling window.
- Telegram acknowledgement is missing.
- job-spec verification is ambiguous.
- one direct unverified claim is observed.
- hot wallet caps are exceeded.
- admin command availability is uncertain.

NO-GO and global pause if:

- program ID mismatch.
- signer-policy bypass.
- creator-review bypass.
- official reward cap bypass.
- official token reward.
- escrow mismatch.
- duplicate settlement.
- dispute resolve replay succeeds.
- pause/type-disable command fails.
- operator alert lane is unavailable while active escrow exists.

## Evidence Bundle

Archive one bundle per canary window:

```bash
tar -czf "agenc-mainnet-canary-evidence-$(date -u +%Y%m%dT%H%M%SZ).tar.gz" "$EVIDENCE_DIR"
```

Required evidence:

- protocol/core/explorer SHAs.
- mainnet program ID and deploy tx.
- protocol config before freeze, after open, and after close/pause.
- signer policy JSON and SHA-256 per role.
- signer-policy denial outputs.
- hot wallet pubkeys and balances before/after.
- task PDA, claim PDA, escrow PDA, job spec hash, validation config PDA.
- artifact SHA-256.
- all create/configure/set-spec/claim/submit/accept tx signatures.
- task/claim/escrow state before and after every lifecycle step.
- explorer `/healthz`, `/api/bootstrap`, `/api/tasks/:taskPda`, and `/api/tasks?q=...` responses.
- contention winner/loser details.
- dispute PDA, vote PDAs, resolve tx, replay negatives, and final state if dispute lane is run.
- Telegram message IDs, ack user, ack timestamp, and first response action.

## Post-Canary Expansion Criteria

Do not widen scope until all are true:

- 72 hours of canary operation.
- at least 10 successful reviewed-public SOL tasks.
- at least 2 successful artifact submissions with digest verification.
- at least 1 successful reject/recovery path.
- at least 1 successful supervised dispute if disputes remain enabled.
- zero escrow mismatches.
- zero duplicate settlements.
- zero creator-review bypasses.
- zero signer-policy bypasses in official flows.
- zero explorer blind spots after polling window.
- all direct-protocol bypass attempts classified and monitored.
- all alerts acknowledged inside SLA.
- one pause/resume drill completed from the runbook.
- evidence reviewed and signed off by engineering and ops.

Expansion order after signoff:

1. Increase concurrent exclusive tasks from 1 to 3.
2. Increase daily task count from 3 to 10.
3. Raise total outstanding escrow cap from `1 SOL` to `3 SOL`.
4. Add more verified workers.
5. Consider higher reward caps after a separate evidence review.
6. Consider non-exclusive task types only after a separate audit and devnet evidence package.
