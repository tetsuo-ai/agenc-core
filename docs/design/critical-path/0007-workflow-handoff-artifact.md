# CP-0007: Govern workflow handoff artifacts

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | Workflow artifact contract (B3a), then bounded scheduler consumption (B3b) |
| Compatibility | Additive artifact kind; old readers and garbage collectors fail closed and preserve unknown bytes |

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
- runtime-owned artifact ID and minimum reader version;
- owning run/workflow and producer step identities;
- exact encoded byte length, media/encoding contract, and SHA-256;
- creation/commit sequence and retention state; and
- references needed for reachability and operator inspection.

Logical workflow, step, group, and task names remain data. Filesystem paths are
derived only from runtime-owned identity and stable hashes. The store uses a
trusted `0700` user-private root, `0600` files, and no-follow/descriptor
containment checks appropriate to the platform, with equivalent per-user,
non-inheriting access controls on Windows.

Publication reserves artifact count and bytes transactionally before file
creation, creates a stable idempotent intent, writes and flushes the exact bytes,
atomically installs the final file, flushes its directory where supported, then
commits metadata. Readers verify kind, ownership, length, and digest before use.
A crash in any earlier phase leaves a non-consumable intent that bounded startup
recovery completes or removes without guessing.

### Bounds and failure semantics

Initial contract limits are:

- 32,768 handoff tokens, with a default ceiling of 8,192;
- 131,072 tokens per full step result;
- 16,777,216 bytes per artifact and 268,435,456 bytes per run;
- 4,294,967,296 bytes globally;
- 4,096 artifacts per run and 100,000 globally;
- 2,048 preview bytes per step and 4,194,304 final-response bytes; and
- 256 cleanup records per keyset page.

Hitting an artifact byte, count, inode, result-token, handoff-token, or
reservation ceiling produces the exact `handoff_failed` path. It retains the
child durable outcome/effect evidence and any independently committed full
output. It never substitutes a truncated artifact, releases a dependency, or
evicts an active reference to admit a smaller artifact. Preview and final tool
responses are constructed incrementally within their separate protocol-byte
ceilings; rendering pressure cannot invalidate an already committed handoff.

Scheduler memory retains only status, digest, byte/token counts, reference, and
bounded preview. Child output is streamed or spilled rather than accumulated in
one result map. Consumers receive a bounded deterministic extract or admitted
reduction plus a digest-bound reference as untrusted data under CP-0008. Raw
child text is never concatenated into workflow policy or template syntax.

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

Rollback disables new workflow scheduling and artifact creation while the
minimum compatible reader continues inspection and cleanup. It preserves all
committed handoffs and child effect evidence until reachability proves them
unreferenced. It MUST NOT expose an unknown kind to old garbage collection or
flatten artifact content back into prompts.

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
