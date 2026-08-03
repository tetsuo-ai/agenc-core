# CP-0007: Govern workflow handoff artifacts

| Field | Value |
| --- | --- |
| Status | B3a artifact contract and B3b event-driven scheduler implemented |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | Workflow artifact contract (B3a) and bounded scheduler consumption (B3b) |
| Compatibility | Exact `workflow_handoff.v1/state-schema.22` epoch; old readers and garbage collectors fail closed and preserve unknown bytes |

## Context

The audited workflow path can concatenate unbounded child final messages into a
consumer prompt. The existing durable artifact surface governs tool results,
not workflow handoff ownership, quotas, restart recovery, or garbage-collection
reachability. A scheduler cannot safely emit references until that artifact
contract exists independently.

## Decision

`workflow_handoff` is a versioned durable artifact kind. Only a committed,
digest-verified artifact may satisfy a workflow dependency. Artifact intent,
reservation, temporary bytes, bounded preview, or a child success status alone
is insufficient.

### Identity and durable publication

The strict artifact record binds:

- artifact format version and `workflow_handoff` kind;
- runtime-owned artifact ID and exact `workflow_handoff.v1/state-schema.22`
  compatibility epoch;
- owning run/workflow and producer step identities;
- exact encoded byte length, media/encoding contract, and SHA-256;
- creation/commit sequence and retention state; and
- references needed for reachability and operator inspection.

Logical workflow, step, group, and task names remain data. Filesystem paths are
derived only from runtime-owned identity and stable hashes. The store uses a
trusted `0700` user-private root, `0600` files, and no-follow/descriptor
containment checks appropriate to the platform, with equivalent per-user,
non-inheriting access controls on Windows.

Publication checks transactionally maintained per-run and global count/byte
ledgers in O(1), then reserves the artifact before file
creation, creates a stable idempotent intent, writes and flushes the exact bytes,
atomically installs the final file, flushes its directory where supported, then
commits metadata. Readers verify kind, ownership, length, and digest before use.
A crash in any earlier phase leaves a non-consumable intent that bounded startup
recovery completes or removes without guessing.

### Bounds and failure semantics

Initial contract limits are:

- 16,777,216 serialized manifest bytes, 100,000 finite JSON nodes, and
  8,388,608 aggregate string UTF-8 bytes across keys and values;
- 32,768 handoff tokens, with a default ceiling of 8,192;
- 131,072 tokens per full step result;
- 16,777,216 bytes per artifact and 268,435,456 bytes per run;
- 4,294,967,296 bytes globally;
- 4,096 artifacts per run and 100,000 globally;
- 2,048 preview bytes per step and 4,194,304 final-response bytes; and
- 256 cleanup records per keyset page.

Whole-document ingestion bounds apply before the independent schema and
semantic maxima. Consequently, object keys, step ids, and reference values
share the 8 MiB string budget, and reference objects share the 100,000-node
budget; a nominal message or alias maximum does not reserve additional bytes or
nodes beyond those whole-document ceilings.

Hitting an artifact byte, count, inode, result-token, handoff-token, or
reservation ceiling produces the exact `handoff_failed` path. It retains the
child durable outcome/effect evidence and any independently committed full
output. It never substitutes a truncated artifact, releases a dependency, or
evicts an active reference to admit a smaller artifact. Preview and final tool
responses are constructed incrementally within their separate protocol-byte
ceilings; rendering pressure cannot invalidate an already committed handoff.

Scheduler memory retains only status, digest, byte/token counts, reference, and
bounded preview. Provider text deltas are synchronously written to a private
disk spool in fixed-size UTF-8 chunks before runtime display aggregation. The
spool retains at most a trailing high surrogate between deltas and resets for
each provider attempt. Byte and token ceilings are checked while deltas arrive;
a ceiling failure aborts the child before publication. Token fallback uses the
central UTF-8 estimator on complete decoded segments, including surrogate pairs
split across provider chunks. Artifact publication consumes the sealed spool as
a repeatable fixed-size source, so neither the scheduler nor the artifact store
constructs a whole child result in memory. Consumers receive a bounded
deterministic extract or admitted reduction plus a digest-bound reference as
untrusted data under CP-0008. Raw child text is never concatenated into workflow
policy or template syntax.

### Retention and cleanup

Referenced committed artifacts do not expire. Unreferenced artifacts become
eligible after seven days, but age alone does not prove deletion safety.
Keyset-paged LRU cleanup under count, byte, and time caps verifies ownership and
reachability, records stable progress, and resumes after crash. Operator cleanup
uses the same proof and exposes safe identity/digest metadata without output
content.

Legacy tool-result artifacts retain their existing semantics. A reader or
garbage collector that does not recognize `workflow_handoff` MUST refuse the
affected workflow/store and preserve the bytes; it may not classify them as
orphaned legacy tool output.

## Migration and rollout

Land the kind registry, strict schema and generated SDK types, ownership and
quota ledger, intent/commit recovery, reachability, and cleanup before a
scheduler emits a reference. Prove legacy tool-result artifacts are unchanged.
Only then may the workflow scheduler release a dependency on a committed
handoff and advertise the new result unions and limits.

## Rollback

Rollback disables new workflow scheduling and artifact creation while a reader
that explicitly implements the `workflow_handoff.v1/state-schema.22` epoch
continues inspection and cleanup. This contract intentionally does not claim
that runtime `0.13.0`, or any other speculative release version, is compatible.
The public and persisted record carry the exact epoch, not a minimum-runtime
semver. Rollback preserves all committed handoffs and child effect evidence
until reachability proves them unreferenced. It MUST NOT expose an unknown kind
to old garbage collection or flatten artifact content back into prompts.

## Alternatives rejected

- Reusing the tool-result artifact kind without distinct ownership/lifecycle.
- Treating a successful child status as proof its handoff is durable.
- Keeping every child final message in scheduler memory or the final response.
- Truncating the only full result and calling the dependency satisfied.
- Wildcard or age-only deletion under global storage pressure.

## Verification obligations

Crash tests cover reservation, intent, write, flush, rename, metadata commit,
reference publication, release, and every cleanup boundary. Tests exercise each
count/byte/token boundary and plus one, 256/257 cleanup candidates, fake-clock
retention, corrupt length/digest, ownership mismatch, unknown kind, two writers,
and restart idempotence. No dependency starts before artifact commit, and no
active artifact is evicted. A 1,024-step workflow remains within artifact,
preview, final-response, and RSS bounds.

Primary references: SQLite's [atomic commit](https://www.sqlite.org/atomiccommit.html),
[RIFL](https://web.stanford.edu/~ouster/cgi-bin/papers/rifl.pdf), and
[OrchBench](https://arxiv.org/abs/2607.25656).

## Implemented B3a and B3b surfaces

The version-1 schema and kind registry live in
`runtime/src/agents/workflow-handoff-schema.ts`, with the standalone JSON
Schema in `workflow-handoff-artifact.v1.schema.json`. Public mirrors are
checked in the runtime's generated SDK types and `@tetsuo-ai/agenc-sdk`.

`WorkflowHandoffArtifactStore` owns intent reservation, exact-byte atomic
publication, commit sequencing, digest-bound reads, references, quota
accounting, restart recovery, and keyset-paged retention cleanup. POSIX uses a
descriptor-confined private root and no-follow child operations. Windows uses
a protected, non-inheriting current-user DACL, rejects reparse points and
non-NTFS roots, publishes with an atomic no-replace hard link, and rechecks
root/file identity and ACLs around each operation. Operator list and inspect
methods return identity, ownership, digest, quota, reachability, and lifecycle
metadata only; they never read artifact output or expose previews.

Migration 022 is additive. Its table accepts only `workflow_handoff` records
with the exact `workflow_handoff.v1/state-schema.22` compatibility epoch and
maintains per-run and global quota aggregates with insert/delete triggers; the
explicit artifact-kind gate continues to recognize the legacy `tool-result`
kind and throws on unknown kinds with an instruction to preserve bytes.

Evidence is in:

- `runtime/tests/agents/workflow-contracts.test.ts`;
- `runtime/tests/bin/workflow-tool-contract.test.ts`;
- `runtime/tests/agents/workflow-handoff-store.test.ts`;
- `runtime/tests/sdk-package/workflow-handoff.contract.test.ts`; and
- `runtime/benchmarks/workflow-contract-1024.ts`.

`compileWorkflowGraph` validates the graph once in O(V + E), and
`runAgentWorkflowV2` consumes each direct edge once while scheduling newly ready
steps immediately. Dependencies are released only after durable artifact commit.
Its ready queue is an append-only FIFO consumed through a monotonic cursor;
public operation counts include both enqueue and dequeue totals so the 1,024-node
guard can reject hidden queue rescans or front-removal regressions.
The public `workflow_result_version: 2` contract preserves failure,
authoritative cancellation, unknown outcome, handoff failure, and both blocked
dependency causes. Scheduler state remains deliberately non-resumable: a daemon
crash never replays steps automatically, while committed artifacts and child
effect evidence remain available for reviewed recovery.

Additional B3b evidence is in:

- `runtime/tests/agents/workflow-graph.test.ts`;
- `runtime/tests/agents/workflow-scheduler.test.ts`;
- `runtime/tests/sdk-package/workflow-result.contract.test.ts`; and
- `runtime/benchmarks/workflow-scheduler-1024.ts`.
