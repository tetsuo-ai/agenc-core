# Marketplace Transaction Intents

Marketplace signer policy should inspect an intent preview before any signer
boundary calls `.rpc()`.

The intent object is normalized so UI, SDK, daemon policy, and CLI bridges can
reason about the same data:

- `kind`: marketplace instruction family, such as `create_task`, `claim_task`,
  `claim_task_with_job_spec`, `complete_task`, `complete_task_private`, or
  `submit_task_result`.
- `programId`: marketplace program that will receive the instruction.
- `signer`: wallet authority expected to sign.
- `taskPda` / `taskId`: task identity when known.
- `jobSpecHash`: off-chain job specification hash when the flow is bound to one.
- `rewardLamports` / `rewardMint`: payout amount and mint.
- `constraintHash`: private ZK circuit/constraint hash when used.
- `accountMetas`: named accounts with pubkey, signer flag, and writable flag.

Use `buildCreateTaskIntent()` before create-task submission and
`TaskOperations.previewClaimTaskIntent()`,
`TaskOperations.previewCompleteTaskIntent()`, or
`TaskOperations.previewCompleteTaskPrivateIntent()` before claim/settlement.

Then call `evaluateMarketplaceSignerPolicyForIntent(policy, intent)`. A policy
can reject wrong program IDs, task PDAs, job spec hashes, constraint hashes,
reward caps, reward mints, or mutated account metas before the signer is used.

The CLI also honors `AGENC_MARKETPLACE_SIGNER_POLICY` as a JSON policy envelope
for `market tasks create`, `market tasks claim`, and `market tasks complete`.
Storefront bridges should set this env var per order instead of relying on a
long-lived unrestricted runtime signer.
