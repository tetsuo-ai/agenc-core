# Internal Runtime API Reference

Internal reference material for the private-kernel package `@tetsuo-ai/runtime`. This document remains in the public repo for kernel contributors and auditability, but `@tetsuo-ai/runtime` is not a supported public builder target. External builders should use `@tetsuo-ai/sdk`, `@tetsuo-ai/protocol`, and `@tetsuo-ai/plugin-kit`.

For a full directory-level runtime map, use [../runtime/docs/MODULE_MAP.md](../runtime/docs/MODULE_MAP.md).

Canonical private-kernel distribution policy lives in [PRIVATE_KERNEL_DISTRIBUTION.md](./PRIVATE_KERNEL_DISTRIBUTION.md). Canonical runtime-side deprecation and support-window policy lives in [PRIVATE_KERNEL_SUPPORT_POLICY.md](./PRIVATE_KERNEL_SUPPORT_POLICY.md).

## Getting Started

```bash
npm --prefix runtime install
npm --prefix runtime run build
```

## Required Validation Lane

Use the root runtime-validation command when changing `@tetsuo-ai/runtime`:

```bash
npm run validate:runtime
```

That command delegates to:

```bash
npm --prefix runtime run validate:required
```

The required lane runs the runtime unit/regression suite plus the mutation,
pipeline-quality, delegation-quality, background-run-quality, and
autonomy-rollout gate scripts. The same root command is enforced in the default
PR workflows `Package Pack Smoke` and `Private Kernel Registry Validation`.

```typescript
import { Connection, Keypair } from '@solana/web3.js';
import {
  AgentRuntime,
  AgentCapabilities,
  createProgram,
  createReadOnlyProgram,
  keypairToWallet,
} from '@tetsuo-ai/runtime';

// Read-only access (queries, event subscriptions — no wallet)
const program = createReadOnlyProgram(connection);

// Full access (transactions — requires wallet)
const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });
const program = createProgram(provider);
```

## Module Map

| Module | Primary Class | Purpose | Config Type |
|--------|--------------|---------|-------------|
| `agent/` | `AgentManager` | Register, update, deregister agents | `AgentManagerConfig` |
| `runtime.ts` | `AgentRuntime` | Lifecycle wrapper around AgentManager | `AgentRuntimeConfig` |
| `autonomous/` | `AutonomousAgent` | Self-operating agent with task discovery | `AutonomousAgentConfig` |
| `task/` | `TaskOperations` | Claim, complete, submit, review, and cancel tasks on-chain | `TaskOpsConfig` |
| `events/` | `EventMonitor` | Subscribe to all protocol events | `EventMonitorConfig` |
| `llm/` | `LLMTaskExecutor` | Bridge LLM providers to task execution | `LLMTaskExecutorConfig` |
| `llm/grok/` | `GrokProvider` | xAI Grok adapter (via `openai` SDK) | `GrokProviderConfig` |
| `llm/anthropic/` | `AnthropicProvider` | Anthropic adapter | `AnthropicProviderConfig` |
| `llm/ollama/` | `OllamaProvider` | Ollama local adapter | `OllamaProviderConfig` |
| `llm/openai-compat/` | `OpenAICompatProvider` | OpenAI-compatible local adapter (LM Studio, llama.cpp, vLLM) | `OpenAICompatProviderConfig` |
| `tools/` | `ToolRegistry` | MCP-compatible tool management | `ToolRegistryConfig` |
| `memory/` | `InMemoryBackend` | Zero-dep memory storage | `InMemoryBackendConfig` |
| `memory/sqlite/` | `SqliteBackend` | SQLite-backed storage | `SqliteBackendConfig` |
| `memory/redis/` | `RedisBackend` | Redis-backed storage | `RedisBackendConfig` |
| `proof/` | `ProofEngine` | ZK proof generation with caching | `ProofEngineConfig` |
| `dispute/` | `DisputeOperations` | Dispute lifecycle transactions | `DisputeOpsConfig` |
| `skills/` | `SkillRegistry` | Skill registration and lifecycle | `SkillRegistryConfig` |

## Common Patterns

### Task Validation V2

`TaskOperations` now covers both immediate public completion and reviewed public completion.

- `configureTaskValidation()` enables creator review, validator quorum, or external attestation for an open public task
- `submitTaskResult()` records a reviewed submission without settling escrow immediately
- `acceptTaskResult()`, `rejectTaskResult()`, and `autoAcceptTaskResult()` resolve creator-review tasks
- `validateTaskResult()` records validator-quorum votes and external attestations
- `completeTask()` auto-routes manual-validation tasks into `submitTaskResult()` so runtime callers do not need to branch manually for that common path
- `completeTaskPrivate()` remains the dedicated zk-backed private completion path
- CLI/runtime artifact delivery is protocol-first: `agenc market tasks complete <taskPda> --artifact-file ./delivery.md` hashes and stores the buyer-facing artifact metadata locally, writes a compact `artifact:sha256:<digest>` reference into the fixed 64-byte result field, and uses the same digest as the public proof hash. URI delivery is supported with `--artifact-uri <ipfs|ar|arweave|https URI> --artifact-sha256 <hex>`.
- The fixed `--result-data` field is not a deliverable rail. Keep it for short legacy notes or compact proof references; use artifact flags when the buyer must review a real report/file/URI.

Use [./architecture/flows/task-lifecycle.md](./architecture/flows/task-lifecycle.md) for the status transitions and sequence diagrams behind these helpers.

### Agent Lifecycle

```typescript
const runtime = new AgentRuntime({
  connection,
  wallet: keypair,
  capabilities: BigInt(AgentCapabilities.COMPUTE | AgentCapabilities.INFERENCE),
  initialStake: 500_000_000n,
  logLevel: 'info',
});

runtime.registerShutdownHandlers(); // SIGINT/SIGTERM
await runtime.start();              // register or load + set Active
// ... agent operations ...
await runtime.stop();               // set Inactive + cleanup
```

### LLM Provider Selection

```typescript
import { GrokProvider, AnthropicProvider, OllamaProvider } from '@tetsuo-ai/runtime';

// Grok (requires: npm install openai)
const grok = new GrokProvider({ apiKey: process.env.XAI_API_KEY!, model: 'grok-3', tools });

// Anthropic (requires: npm install @anthropic-ai/sdk)
const anthropic = new AnthropicProvider({ apiKey: '...', model: 'claude-sonnet-4-5-20250929', tools });

// Ollama (requires: npm install ollama + local Ollama server)
const ollama = new OllamaProvider({ model: 'llama3', tools });

// OpenAI-compatible local server (LM Studio, llama.cpp, vLLM)
// baseUrl is validated on startup to be a local/LAN address
const local = new OpenAICompatProvider({
  model: 'google_gemma-4-26b-a4b-it',
  baseUrl: 'http://127.0.0.1:1234/v1',
  apiKey: 'local',             // not validated by local servers
  contextWindowTokens: 32768,  // required — local servers don't expose this
  tools,
});
```

All providers implement `LLMProvider`: `chat()`, `chatStream()`, `healthCheck()`.

### Tool Wiring (Critical Two-Site Pattern)

Both sites must be connected for tool calls to work:

```typescript
import { ToolRegistry, createAgencTools, LLMTaskExecutor } from '@tetsuo-ai/runtime';

const registry = new ToolRegistry({ logger });
registry.registerAll(createAgencTools({ connection, program, logger }));

// Site 1: Tool DEFINITIONS go to the provider (so the LLM knows what tools exist)
const provider = new GrokProvider({ apiKey, model, tools: registry.toLLMTools() });

// Site 2: Tool HANDLER goes to the executor (executes tool calls during task loop)
const executor = new LLMTaskExecutor({
  provider,
  toolHandler: registry.createToolHandler(),
});
```

`createAgencTools()` is intentionally read-only by default. Signer-backed marketplace
mutation tools such as `agenc.createTask`, `agenc.claimTask`, and
`agenc.completeTask` must be enabled explicitly:

```typescript
registry.registerAll(
  createAgencTools(
    { connection, wallet, logger },
    { includeMutationTools: true },
  ),
);
```

For daemon/gateway deployments, mutation tools are still fail-closed unless
`policy.marketplaceSigningToolsEnabled: true`, a wallet is loaded, and gateway
approvals are enabled.

Daemon signing should also include a local signer capability policy. Without one,
the daemon registers mutation tools behind approvals but denies every marketplace
signature attempt:

```json
{
  "policy": {
    "marketplaceSigningToolsEnabled": true,
    "marketplaceSignerPolicy": {
      "allowedTools": ["agenc.claimTask", "agenc.completeTask"],
      "allowedProgramIds": ["2jdBSJ8U5ixfwgs1bRLPtRRnpZAPm8Xv1tEdu8yjHJC7"],
      "allowedTaskPdas": ["..."],
      "maxRewardLamports": "100000000",
      "allowedRewardMints": ["SOL"]
    }
  },
  "approvals": {
    "enabled": true
  }
}
```

### Memory Integration

```typescript
import { InMemoryBackend, entryToMessage } from '@tetsuo-ai/runtime';

const memory = new InMemoryBackend({ maxEntriesPerSession: 1000 });

// Store entries
await memory.addEntry({ sessionId: 'sess-1', role: 'user', content: 'Hello' });

// Retrieve and convert to LLM format
const thread = await memory.getThread('sess-1');
const llmMessages = thread.map(entryToMessage);

// Key-value storage
await memory.set('config:model', 'grok-3', 300_000); // with 5min TTL
const model = await memory.get<string>('config:model');
```

### Event Subscription

```typescript
import { EventMonitor, createReadOnlyProgram } from '@tetsuo-ai/runtime';

// Read-only program works for events (uses Connection WebSocket internally)
const program = createReadOnlyProgram(connection);
const monitor = new EventMonitor({ program, logger });

monitor.subscribeToTaskEvents({
  onTaskCreated: (event, slot, sig) => { /* ... */ },
  onTaskCompleted: (event) => { /* ... */ },
});

monitor.subscribeToDisputeEvents({ /* ... */ });
monitor.subscribeToProtocolEvents({ /* ... */ });
monitor.subscribeToAgentEvents({ /* ... */ });

monitor.start();
const metrics = monitor.getMetrics(); // { totalEventsReceived, eventCounts, uptimeMs }
await monitor.stop();
```

### Proof Generation

```typescript
import { ProofEngine } from '@tetsuo-ai/runtime';

const engine = new ProofEngine({
  proverBackend: {
    kind: 'remote',
    endpoint: 'https://prover.example.com',
  },
  methodId: trustedImageIdBytes,
  routerConfig: {
    routerProgramId,
    routerPda,
    verifierEntryPda,
    verifierProgramId,
  },
  cache: { ttlMs: 300_000, maxEntries: 100 },
});

const result = await engine.generate({
  taskPda, agentPubkey,
  output: [1n, 2n, 3n, 4n],
  salt: engine.generateSalt(),
  agentSecret: secretWitnessBigint,
});
// result.fromCache, result.verified, result.proofSize
```

Private proof generation fails closed unless `methodId` and the full
`routerConfig` are pinned. The only bypass is
`unsafeAllowUnpinnedPrivateProofs: true`, which should be used only for local
development.

### Dispute Operations

```typescript
import { DisputeOperations } from '@tetsuo-ai/runtime';

const ops = new DisputeOperations({ program, agentId, logger });

const active = await ops.fetchActiveDisputes();      // memcmp-filtered
const forTask = await ops.fetchDisputesForTask(taskPda);

await ops.initiateDispute({ disputeId, taskPda, taskId, evidenceHash, resolutionType: 0, evidence: '...' });
await ops.voteOnDispute({ disputePda, taskPda, approve: true });
await ops.resolveDispute({ disputePda, taskPda, creatorPubkey, arbiterVotes: [...] });
await ops.cancelDispute(disputePda, taskPda);
await ops.expireDispute({ disputePda, taskPda, creatorPubkey, arbiterVotes: [] });
await ops.applySlash({ disputePda, taskPda, workerClaimPda, workerAgentPda });
```

## Error Handling

### RuntimeErrorCodes (31 codes)

| Code | Error Class | Phase |
|------|-------------|-------|
| `AGENT_NOT_REGISTERED` | `AgentNotRegisteredError` | 1 |
| `AGENT_ALREADY_REGISTERED` | `AgentAlreadyRegisteredError` | 1 |
| `VALIDATION_ERROR` | `ValidationError` | 1 |
| `RATE_LIMIT_ERROR` | `RateLimitError` | 1 |
| `INSUFFICIENT_STAKE` | `InsufficientStakeError` | 1 |
| `ACTIVE_TASKS_ERROR` | `ActiveTasksError` | 1 |
| `PENDING_DISPUTE_VOTES` | `PendingDisputeVotesError` | 1 |
| `RECENT_VOTE_ACTIVITY` | `RecentVoteActivityError` | 1 |
| `TASK_NOT_FOUND` | `TaskNotFoundError` | 3 |
| `TASK_NOT_CLAIMABLE` | `TaskNotClaimableError` | 3 |
| `TASK_EXECUTION_FAILED` | `TaskExecutionError` | 3 |
| `TASK_SUBMISSION_FAILED` | `TaskSubmissionError` | 3 |
| `EXECUTOR_STATE_ERROR` | `ExecutorStateError` | 3 |
| `TASK_TIMEOUT` | `TaskTimeoutError` | 3 |
| `CLAIM_EXPIRED` | — | 3 |
| `RETRY_EXHAUSTED` | — | 3 |
| `LLM_PROVIDER_ERROR` | `LLMProviderError` | 4 |
| `LLM_RATE_LIMIT` | `LLMRateLimitError` | 4 |
| `LLM_RESPONSE_CONVERSION` | `LLMResponseConversionError` | 4 |
| `LLM_TOOL_CALL_ERROR` | `LLMToolCallError` | 4 |
| `LLM_TIMEOUT` | `LLMTimeoutError` | 4 |
| `MEMORY_BACKEND_ERROR` | `MemoryBackendError` | 6 |
| `MEMORY_CONNECTION_ERROR` | `MemoryConnectionError` | 6 |
| `MEMORY_SERIALIZATION_ERROR` | `MemorySerializationError` | 6 |
| `PROOF_GENERATION_ERROR` | `ProofGenerationError` | 7 |
| `PROOF_VERIFICATION_ERROR` | `ProofVerificationError` | 7 |
| `PROOF_CACHE_ERROR` | `ProofCacheError` | 7 |
| `DISPUTE_NOT_FOUND` | `DisputeNotFoundError` | 8 |
| `DISPUTE_VOTE_ERROR` | `DisputeVoteError` | 8 |
| `DISPUTE_RESOLUTION_ERROR` | `DisputeResolutionError` | 8 |
| `DISPUTE_SLASH_ERROR` | `DisputeSlashError` | 8 |

All error classes extend `RuntimeError` which has a `code: string` field.

```typescript
import { isRuntimeError, RuntimeErrorCodes } from '@tetsuo-ai/runtime';

try {
  await manager.register(params);
} catch (err) {
  if (isRuntimeError(err) && err.code === RuntimeErrorCodes.INSUFFICIENT_STAKE) {
    // Handle specific error
  }
}
```

### Anchor Error Mapping

Use `isAnchorError()` and `parseAnchorError()` for on-chain errors:

```typescript
import { isAnchorError, parseAnchorError, getAnchorErrorName } from '@tetsuo-ai/runtime';

try {
  await program.methods.claimTask().rpc();
} catch (err) {
  if (isAnchorError(err)) {
    const parsed = parseAnchorError(err);
    console.log(parsed.code, parsed.name, parsed.message);
  }
}
```

## Configuration Reference

### AgentRuntimeConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `connection` | `Connection` | Yes | — |
| `wallet` | `Keypair \| Wallet` | Yes | — |
| `programId` | `PublicKey` | No | `PROGRAM_ID` |
| `agentId` | `Uint8Array` | No | Random 32 bytes |
| `capabilities` | `bigint` | For new agents | — |
| `endpoint` | `string` | No | `agent://<short_id>` |
| `metadataUri` | `string` | No | — |
| `initialStake` | `bigint` | No | `0n` |
| `logLevel` | `LogLevel` | No | Silent |

### LLMProviderConfig (shared base)

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `model` | `string` | Yes | — |
| `systemPrompt` | `string` | No | — |
| `temperature` | `number` | No | — |
| `maxTokens` | `number` | No | — |
| `tools` | `LLMTool[]` | No | — |
| `timeoutMs` | `number` | No | — |
| `maxRetries` | `number` | No | — |

Provider-specific additions:
- **GrokProviderConfig**: `apiKey` (required), `baseURL`, `webSearch`, `searchMode`
- **AnthropicProviderConfig**: `apiKey` (required)
- **OllamaProviderConfig**: `baseURL` (default: `http://localhost:11434`)
- **OpenAICompatProviderConfig**: `baseUrl` (required, must be local/LAN), `apiKey` (required, any string), `contextWindowTokens` (required)

When `GrokProviderConfig.webSearch=true`, the runtime can route provider-native `web_search` into Grok Responses calls without exposing a client-executed tool in the gateway registry. `searchMode="auto"` prefers `web_search` for research/docs/reference comparisons while preserving browser MCP tools for interactive validation; delegated research evidence can be satisfied by provider citations surfaced as `providerEvidence.citations`. This path is model-gated: unsupported Grok models such as `grok-code-fast-1` must suppress `web_search` even when the config flag is set.

### Local Inference (openai-compat)

Use `openai-compat` for any server that exposes the OpenAI `/v1/chat/completions`
interface locally — LM Studio, llama.cpp server, vLLM, or any compatible runner.
This provider does **not** require xAI credentials and does not enforce a model
catalog: the server's `GET /v1/models` response is the authoritative source of truth.

**Startup validation** runs three checks before the provider is returned:
1. `baseUrl` resolves to a local or LAN address (`127.x`, `10.x`, `192.168.x`, `172.16-31.x`, `localhost`)
2. `GET {baseUrl}/models` is reachable within 5 seconds
3. The configured `model` appears in the `/v1/models` response

```json
{
  "llm": {
    "provider": "openai-compat",
    "model": "google_gemma-4-26b-a4b-it",
    "baseUrl": "http://127.0.0.1:1234/v1",
    "apiKey": "local",
    "contextWindowTokens": 32768,
    "maxTokens": 4096
  }
}
```

**Notes:**
- `contextWindowTokens` is required — local servers do not expose context window size via API. The AgenC system prompt alone requires more than 14K tokens, so 32768 is the recommended minimum. Values below 16384 will likely cause failures before the user sends a single message.
- `apiKey` is passed in the `Authorization` header but is not validated by local servers. Any non-empty string works.
- When running untrusted models, set `workspace.hostPath` to a neutral directory to prevent autonomous file access during initial context loading.
- LM Studio: set the context window in the model settings to match `contextWindowTokens`. The LM Studio default of 4096 is too small for most system prompts.
- Use `provider: "ollama"` instead when using Ollama with its native SDK; `openai-compat` is the right choice when Ollama is running in OpenAI-compatibility mode or when using LM Studio / llama.cpp.

### LLMTaskExecutorConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `provider` | `LLMProvider` | Yes | — |
| `systemPrompt` | `string` | No | — |
| `streaming` | `boolean` | No | `false` |
| `onStreamChunk` | `StreamProgressCallback` | No | — |
| `toolHandler` | `ToolHandler` | No | — |
| `maxToolRounds` | `number` | No | `10` |
| `responseToOutput` | `(response: string) => bigint[]` | No | SHA-256 converter |
| `requiredCapabilities` | `bigint` | No | — |

### Memory Backend Configs

| Backend | Key Options | Defaults |
|---------|------------|----------|
| `InMemoryBackend` | `maxEntriesPerSession`, `maxTotalEntries`, `defaultTtlMs` | 1000, 100k, none |
| `SqliteBackend` | `dbPath`, `walMode`, `cleanupOnConnect` | `:memory:`, true, true |
| `RedisBackend` | `url` or `host`/`port`, `keyPrefix`, `connectTimeoutMs` | —, `agenc:memory:`, 5000 |

### ProofEngineConfig

| Field | Type | Required | Default |
|-------|------|----------|---------|
| `proverBackend.kind` | `"remote"` | Yes | — |
| `proverBackend.endpoint` | `string` | If `kind="remote"` | — |
| `proverBackend.timeoutMs` | `number` | No | SDK default |
| `proverBackend.headers` | `Record<string, string>` | No | — |
| `methodId` | `Uint8Array` | Required for private proving | — |
| `routerConfig.routerProgramId` | `PublicKey` | Required for private proving | — |
| `routerConfig.routerPda` | `PublicKey` | Required for private proving | — |
| `routerConfig.verifierEntryPda` | `PublicKey` | Required for private proving | — |
| `routerConfig.verifierProgramId` | `PublicKey` | Required for private proving | — |
| `unsafeAllowUnpinnedPrivateProofs` | `boolean` | No | `false` (development only) |
| `cache.ttlMs` | `number` | No | `300_000` |
| `cache.maxEntries` | `number` | No | `100` |

## Gateway Config

The `gateway` block controls the WebSocket control plane. All fields except `port` are optional.

| Field | Type | Default | Description |
|---|---|---|---|
| `gateway.port` | `number` | `3100` | WebSocket control plane port |
| `gateway.bind` | `string` | `"127.0.0.1"` | Bind address. Set to `"0.0.0.0"` for Docker or remote access. Requires `auth.secret` when non-loopback. |

> **Security note:** When `gateway.bind` is set to a non-loopback address, `auth.secret` is required or startup will fail with a `GatewayValidationError`.

### Docker scenarios

#### Scenario 1 — Docker with browser UI (macOS / no `--network host`)

```json
{
  "gateway": {
    "port": 3100,
    "bind": "0.0.0.0"
  }
}
```

> **`auth.secret` cannot be used with Docker port mapping on macOS** (or any
> platform where `--network host` is unavailable). When a browser connects to
> `localhost:3100` on the host, Docker translates it through the bridge network
> and the daemon sees the connection arriving from the Docker bridge gateway IP
> (e.g. `192.168.97.1`), not `127.0.0.1`. The `isLocal` check in the gateway
> only accepts `127.0.0.1`, `::1`, and `::ffff:127.0.0.1`, so `localBypass`
> never fires for browser connections via port mapping. The dashboard HTML is
> also served as plain static files with no JWT token injected, so the web UI
> has no way to authenticate against `auth.secret` at all. Omit `auth.secret`
> entirely when you need the browser-based web UI to work over Docker port
> mapping. Note that `gateway.bind: "0.0.0.0"` normally requires `auth.secret`
> or startup will fail — see the validation note above. If you need both
> `bind: "0.0.0.0"` and no `auth.secret`, use a firewall or Docker network
> policy to restrict access instead.

#### Scenario 2 — Docker CLI only (`docker exec` sessions, no browser UI)

```json
{
  "gateway": {
    "port": 3100,
    "bind": "0.0.0.0"
  },
  "auth": {
    "secret": "your-secret-here",
    "localBypass": true
  }
}
```

> **`localBypass: true` only authenticates connections whose `remoteAddress` is
> exactly `127.0.0.1`, `::1`, or `::ffff:127.0.0.1`.** This covers CLI tools
> run inside the container via `docker exec` (e.g. `agenc watch`, `agenc status`)
> because those connect to `ws://127.0.0.1:3100` directly. It does **not** cover
> browser connections routed through Docker port mapping — those arrive from the
> bridge IP and remain unauthenticated. Use this scenario when you need
> `auth.secret` for webhook or API security and are willing to forgo the
> browser-based web UI.

> **Common mistake:** Setting `gateway.host` has no effect — the correct field is `gateway.bind`. The `host` field is not part of `GatewayBindConfig` and is silently ignored.

## Runtime Pipeline Config Profiles

These profiles target the gateway runtime pipeline (`ChatExecutor` + provider adapters). Copy into `~/.agenc/config.json` and adjust secrets/ports/RPC URLs.

### Profile 1: Safe Defaults (recommended)

Use for most production channels where correctness and predictable behavior matter more than raw throughput.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 60000,
    "toolCallTimeoutMs": 180000,
    "requestTimeoutMs": 0,
    "parallelToolCalls": false,
    "contextWindowTokens": 131072,
    "promptSafetyMarginTokens": 2048,
    "promptHardMaxChars": 12000,
    "maxRuntimeHints": 4,
    "plannerEnabled": true,
    "plannerMaxTokens": 320,
    "maxToolRounds": 5,
    "toolBudgetPerRequest": 10,
    "maxModelRecallsPerRequest": 0,
    "maxFailureBudgetPerRequest": 3,
    "retryPolicy": {
      "timeout": { "maxRetries": 2 },
      "provider_error": { "maxRetries": 2 },
      "rate_limited": { "maxRetries": 3 }
    },
    "toolFailureCircuitBreaker": {
      "enabled": true,
      "threshold": 5,
      "windowMs": 300000,
      "cooldownMs": 120000
    },
    "statefulResponses": {
      "enabled": true,
      "store": false,
      "fallbackToStateless": true,
      "compaction": {
        "enabled": true,
        "compactThreshold": 20000,
        "fallbackOnUnsupported": true
      }
    }
  }
}
```

`llm.maxModelRecallsPerRequest` treats `0` as unlimited. `llm.requestTimeoutMs` also treats `0` or omission as unlimited, which is now the default mode. Long autonomous runs are then governed by tool budgets, no-progress detection, failure breakers, and any narrower provider/tool timeouts you keep enabled.

### Profile 2: High Throughput

Use for high-volume low-latency channels where strict retries are less valuable than fast turn completion.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 30000,
    "toolCallTimeoutMs": 90000,
    "requestTimeoutMs": 180000,
    "parallelToolCalls": false,
    "contextWindowTokens": 131072,
    "promptSafetyMarginTokens": 2048,
    "promptHardMaxChars": 10000,
    "maxRuntimeHints": 2,
    "plannerEnabled": false,
    "maxToolRounds": 4,
    "toolBudgetPerRequest": 8,
    "maxModelRecallsPerRequest": 1,
    "maxFailureBudgetPerRequest": 2,
    "statefulResponses": {
      "enabled": true,
      "store": false,
      "fallbackToStateless": true,
      "compaction": {
        "enabled": true,
        "compactThreshold": 16000,
        "fallbackOnUnsupported": true
      }
    },
    "toolRouting": {
      "enabled": true,
      "minToolsPerTurn": 8,
      "maxToolsPerTurn": 24,
      "maxExpandedToolsPerTurn": 32
    }
  }
}
```

### Profile 3: Local Debug

Use during incident triage. This profile prioritizes observability and reproducibility over cost/latency.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 60000,
    "toolCallTimeoutMs": 240000,
    "requestTimeoutMs": 900000,
    "parallelToolCalls": false,
    "plannerEnabled": true,
    "plannerMaxTokens": 320,
    "maxToolRounds": 6,
    "toolBudgetPerRequest": 12,
    "maxModelRecallsPerRequest": 3,
    "maxFailureBudgetPerRequest": 4,
    "statefulResponses": {
      "enabled": true,
      "store": false,
      "fallbackToStateless": true,
      "compaction": {
        "enabled": true,
        "compactThreshold": 12000,
        "fallbackOnUnsupported": true
      }
    }
  },
  "logging": {
    "level": "info",
    "trace": {
      "enabled": true,
      "includeHistory": true,
      "includeSystemPrompt": true,
      "includeToolArgs": true,
      "includeToolResults": true,
      "includeProviderPayloads": true,
      "maxChars": 20000,
      "fanout": {
        "enabled": true
      }
    }
  }
}
```

With `logging.trace.enabled=true`, daemon trace logs emit single-line JSON `*.executor.*` events that record the authoritative in-memory execution ledger for each turn: model-call preparation, contract guidance resolution, rejected tool calls, tool dispatch start/finish, route expansion, and completion-gate decisions.

With `logging.trace.includeProviderPayloads=true`, daemon trace logs also emit `*.provider.request`, `*.provider.response`, and `*.provider.error` events that contain the exact provider payloads after runtime routing/tool-choice shaping. Those request events now include tool-selection context such as requested tool names, resolved tool names, missing routed tools, and the resolution strategy actually used at the provider boundary. Use payload capture only during triage; it duplicates prompt content and can make logs large quickly.

The runtime also persists those trace events into the local observability store at `~/.agenc/observability.sqlite`. The WebChat operator surface can query that store through:

- `observability.summary`
- `observability.traces`
- `observability.trace`
- `observability.artifact`
- `observability.logs`

These queries power the WebChat `TRACE` view, which combines summary metrics, trace timelines, exact artifact payloads under `~/.agenc/trace-payloads/`, and trace-filtered daemon log slices without requiring operators to grep raw logs first.

In foreground tmux or other multi-daemon local runs, the runtime now tees foreground daemon output into the configured daemon log path as well. That keeps pane scrollback, `observability.logs`, and exported debug bundles aligned even when each agent uses its own log file (for example `~/.agenc/localnet-soak/default/social/logs/agent-1.log`).

When `logging.trace.enabled=true`, bounded concern-based derived files are enabled by default unless `logging.trace.fanout.enabled=false`. They live next to the active daemon log and mirror the same canonical trace stream into `*.provider.log`, `*.executor.log`, `*.subagents.log`, and `*.errors.log` views. Treat those files as operator conveniences, not separate sources of truth.

When the executor normalizes or repairs tool arguments immediately before dispatch, `*.executor.tool_dispatch_started` trace events can include `argumentDiagnostics`. This payload records the repair source plus the repaired fields so operators can distinguish model-supplied arguments from deterministic runtime repair during incident replay.

### Profile 4: Delegation SOTA (subagent orchestration + policy learning)

Use for multi-step delegated workloads where planner DAG execution, verifier gates, and learning-based routing should be active.

```json
{
  "llm": {
    "provider": "grok",
    "apiKey": "${XAI_API_KEY}",
    "model": "grok-3",
    "timeoutMs": 60000,
    "toolCallTimeoutMs": 180000,
    "requestTimeoutMs": 0,
    "parallelToolCalls": false,
    "plannerEnabled": true,
    "plannerMaxTokens": 320,
    "maxToolRounds": 6,
    "toolBudgetPerRequest": 12,
    "maxModelRecallsPerRequest": 3,
    "maxFailureBudgetPerRequest": 4,
    "statefulResponses": {
      "enabled": true,
      "store": false,
      "fallbackToStateless": true,
      "compaction": {
        "enabled": true,
        "compactThreshold": 18000,
        "fallbackOnUnsupported": true
      }
    },
    "subagents": {
      "enabled": true,
      "mode": "hybrid",
      "delegationAggressiveness": "balanced",
      "maxConcurrent": 6,
      "maxDepth": 4,
      "maxFanoutPerTurn": 8,
      "maxTotalSubagentsPerRequest": 32,
      "maxCumulativeToolCallsPerRequestTree": 256,
      "maxCumulativeTokensPerRequestTree": 0,
      "defaultTimeoutMs": 120000,
      "spawnDecisionThreshold": 0.2,
      "handoffMinPlannerConfidence": 0.82,
      "forceVerifier": true,
      "allowParallelSubtasks": true,
      "hardBlockedTaskClasses": [
        "wallet_signing",
        "wallet_transfer",
        "stake_or_rewards",
        "credential_exfiltration"
      ],
      "childToolAllowlistStrategy": "inherit_intersection",
      "childProviderStrategy": "same_as_parent",
      "fallbackBehavior": "continue_without_delegation",
      "policyLearning": {
        "enabled": true,
        "epsilon": 0.1,
        "explorationBudget": 500,
        "minSamplesPerArm": 2,
        "ucbExplorationScale": 1.2,
        "arms": [
          { "id": "conservative", "thresholdOffset": 0.1 },
          { "id": "balanced", "thresholdOffset": 0.0 },
          { "id": "aggressive", "thresholdOffset": -0.1 }
        ]
      }
    }
  }
}
```

Set `llm.subagents.maxCumulativeTokensPerRequestTree` to `0` or omit it to allow autonomous child-request trees to run without a cumulative token ceiling. Use a positive integer only when you want a hard tree-wide stop condition.

### Stateful Response Compaction

`llm.statefulResponses.compaction` controls AgenC's compaction policy around
stateful responses. On xAI/Grok, AgenC treats this as a local/runtime compaction
threshold and does not rely on undocumented provider fields. The current runtime
surface is:

- `enabled`: turn compaction-aware stateful handling on.
- `compactThreshold`: rendered-token threshold after which AgenC may compact or
  trim local carried-forward state.
- `fallbackOnUnsupported`: retry once without optional provider hints if a
  provider rejects them.

The runtime preserves local assistant `phase` metadata in AgenC history and
includes continuation diagnostics in call-level traces so compacted
continuations remain replayable without assuming undocumented xAI behavior.

When `compactThreshold` is omitted on Grok, AgenC now derives the local
compaction threshold from the resolved model context window at roughly 60% of
capacity. If the context window cannot be resolved, AgenC falls back to
`16,000` tokens.

### Host vs Desktop Browser Tooling

The tool surface is intentionally split by environment:

- `system.browserSession*` is host-scoped and only available when
  `desktop.environment` is `"host"` or `"both"`.
- `system.sqlite*` and `system.pdf*` are host-scoped typed inspection tools for
  local databases and documents. They stay available in desktop mode because
  they are structured read-only host tools, not raw host mutation surfaces.
- `system.spreadsheet*` is a host-scoped typed table/workbook inspection family
  for local CSV/TSV/XLS/XLSX files and also remains available in desktop mode
  for the same reason.
- `system.officeDocument*` is a host-scoped typed office-document inspection
  family for local DOCX/ODT files and also remains available in desktop mode
  for the same reason.
- `system.emailMessage*` and `system.calendar*` are host-scoped typed
  productivity inspection families for local EML and ICS files and also remain
  available in desktop mode for the same reason.
- `mcp.browser.*` / `playwright.*` is desktop-scoped and remains the correct
  choice for visible browser automation inside the sandboxed desktop.

If you run the gateway in `desktop`-only mode, the runtime will correctly filter
raw host-mutation tools like `system.bash`, while still exposing structured
host families such as `system.process*`, `system.server*`, `system.browserSession*`,
`system.sqlite*`, `system.pdf*`, `system.spreadsheet*`,
`system.officeDocument*`, `system.emailMessage*`, and `system.calendar*` when
their contracts are safe for that mode.

### Profile Selection Guide

| Profile | Best For | Tradeoff |
|---------|----------|----------|
| Safe defaults | General production | Higher latency than throughput profile |
| High throughput | High-turnover chat workloads | Less retry depth and tighter budgets |
| Local debug | Incident triage and reproductions | Large logs and higher token spend |
| Delegation SOTA | Multi-step delegated workflows | More orchestration overhead and additional eval requirements |

## Delegation Runtime Surface (Gateway)

When `llm.subagents.enabled=true`, gateway/runtime expose orchestration controls in `GatewayLLMConfig.subagents`:

- execution mode: `mode` (`manager_tools`, `handoff`, `hybrid`)
- aggressiveness profile: `delegationAggressiveness` (`conservative`, `balanced`, `aggressive`, `adaptive`)
- hard safety caps: depth/fanout/children/tool-calls/tokens
- policy controls: `spawnDecisionThreshold`, `handoffMinPlannerConfidence`, `hardBlockedTaskClasses`, `allowedParentTools`, `forbiddenParentTools`
- verifier controls: `forceVerifier`
- child least-privilege policy: `childToolAllowlistStrategy`
- child provider routing: `childProviderStrategy` (`same_as_parent`, `capability_matched`)
- fallback behavior: `continue_without_delegation` or `fail_request`
- online policy learning: `llm.subagents.policyLearning.*`

Runtime exposes a live slash-command override for operators:

- `/delegation status`
- `/delegation conservative|balanced|aggressive|adaptive`
- `/delegation default`

Oversized delegated steps now surface a structured `needs_decomposition` signal. The parent planner consumes that signal and performs one bounded refinement pass to split the work into smaller `subagent_task` nodes instead of looping on the same overloaded child objective.

### Runtime response diagnostics for delegation

`ChatExecutorResult.plannerSummary` includes delegation fields:

- `delegationDecision`
- `subagentVerification`
- `delegationPolicyTuning`
- `diagnostics` entries such as `subagent_step_needs_decomposition`, `planner_refinement_retry`, and `planner_runtime_refinement_retry`

`delegationPolicyTuning` now includes useful-delegation reward proxy diagnostics:

- `usefulDelegation`
- `usefulDelegationScore`
- `rewardProxyVersion`

These diagnostics are emitted in trace logs and available to channel adapters for user-visible lifecycle timelines.

For delegated turns, the trace payload also includes summarized `execute_with_agent` arguments and results so operators can inspect the child objective, contract, acceptance criteria, validation code, stop reason, and nested tool-call outcomes without reconstructing them from UI summaries.

For any turn that reaches post-tool synthesis, the runtime also injects an authoritative execution-ledger system message into the final model call. The ledger is derived from actual `ToolCallRecord[]` plus provider-native evidence, and includes tool names, sanitized arguments, success/error status, durations, result previews, and provider citations. This is an external grounding aid for the final answer; it is not taken from model prose.

For Grok research incidents, also inspect:

- `toolRouting.allowedToolNames` for `web_search`
- `ChatExecutorResult.providerEvidence.citations`
- delegated child `providerEvidence.citations` inside `execute_with_agent` result payloads

If citations are present, research evidence came from provider-native search rather than browser MCP calls.

### Delegation benchmarking scripts

```bash
npm --prefix runtime run benchmark:delegation
npm --prefix runtime run benchmark:delegation:ci
npm --prefix runtime run benchmark:delegation:gates
npm --prefix runtime run benchmark:decomposition-search
```

These scripts are release-gate inputs for delegation quality, reliability, and quality-cost Pareto promotion behavior.

## Capability Constants

```typescript
import { AgentCapabilities, hasCapability, getCapabilityNames } from '@tetsuo-ai/runtime';

AgentCapabilities.COMPUTE     // 1n << 0n
AgentCapabilities.INFERENCE   // 1n << 1n
AgentCapabilities.STORAGE     // 1n << 2n
AgentCapabilities.NETWORK     // 1n << 3n
AgentCapabilities.SENSOR      // 1n << 4n
AgentCapabilities.ACTUATOR    // 1n << 5n
AgentCapabilities.COORDINATOR // 1n << 6n
AgentCapabilities.ARBITER     // 1n << 7n
AgentCapabilities.VALIDATOR   // 1n << 8n
AgentCapabilities.AGGREGATOR  // 1n << 9n
```

## Examples

| Example | Path | Demonstrates |
|---------|------|-------------|
| Autonomous Agent | `examples/autonomous-agent/` | Task discovery, execution, ZK proofs |
| LLM Agent | `examples/llm-agent/` | LLM providers, tool calling, streaming |
| Dispute Arbiter | `examples/dispute-arbiter/` | DisputeOperations, voting, event monitoring |
| Memory Agent | `examples/memory-agent/` | InMemoryBackend, session threads, KV store |
| Event Dashboard | `examples/event-dashboard/` | EventMonitor, read-only mode, all event types |
| Skill Jupiter | `examples/skill-jupiter/` | JupiterSkill, swap quotes, token balances |

## Links

- [CLAUDE.md](../CLAUDE.md) — Comprehensive type signatures and architecture
- [SDK README](https://github.com/tetsuo-ai/agenc-sdk/blob/main/README.md) — SDK usage documentation
- [Architecture](architecture.md) — System architecture overview
