# Marketplace Transaction Intents

Marketplace signer policy should inspect an intent preview before any signer
boundary calls `.rpc()`.

The private runtime keeps legacy `agenc.*` tool names for compatibility, but
the final intent-level policy evaluation delegates to the public
`agenc-marketplace-agent-kit/policy` evaluator. That keeps core aligned with
the framework-neutral Codex/Claude/Hermes marketplace agent kit without making
external integrations depend on `@tetsuo-ai/runtime` or the private MCP package.

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
- `taskType`: task type when known; canary policy should restrict this to
  `Exclusive`.
- `validationMode`: validation mode when known; canary policy should restrict
  this to `CreatorReview`.
- `hasArtifactDelivery` / `artifactSha256`: artifact commitment metadata when
  an artifact rail is used.
- `requiresCreatorReview`: whether the final intent is routed through
  CreatorReview/manual validation.
- `jobSpecVerified`: whether the claim path used verified job-spec metadata.
- `constraintHash`: private ZK circuit/constraint hash when used.
- `accountMetas`: named accounts with pubkey, signer flag, and writable flag.

Use `buildCreateTaskIntent()` before create-task submission and
`TaskOperations.previewClaimTaskIntent()`,
`TaskOperations.previewCompleteTaskIntent()`, or
`TaskOperations.previewCompleteTaskPrivateIntent()` before claim/settlement.

Then call `evaluateMarketplaceSignerPolicyForIntent(policy, intent)`. A policy
can reject wrong program IDs, task PDAs, job spec hashes, constraint hashes,
reward caps, reward mints, task types, validation modes, public auto-settle
artifact attempts, missing job-spec verification, private ZK completion, or
mutated account metas before the signer is used.

When `expectedAccountMetas` is supplied, the delegated public agent-kit policy
uses strict account-meta matching by default. That means unexpected extra
writable or signer accounts are rejected unless `strictAccountMetas: false` is
set deliberately for a narrow preview-only case.

For the reviewed-public canary, signer policies should include:

- `allowedTaskTypes: ["Exclusive"]`
- `allowedValidationModes: ["CreatorReview"]`
- `allowedRewardMints: ["SOL"]`
- `maxRewardLamports: "50000000"`
- `requireCreatorReviewForArtifacts: true`
- `requireJobSpecVerification: true`
- `denyPrivateZk: true`
- `denyTokenRewards: true`
- `denyPublicAutoSettleArtifacts: true`

The CLI also honors `AGENC_MARKETPLACE_SIGNER_POLICY` as a JSON policy envelope
for `market tasks create`, `market tasks claim`, and `market tasks complete`.
Storefront bridges should set this env var per order instead of relying on a
long-lived unrestricted runtime signer.

Do not expose signer-backed marketplace tools through a remote public HTTP MCP
server. Signer mode is local-only by default; use low-balance hot wallets and
policy allowlists as the fund-protection boundary.
