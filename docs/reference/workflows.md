# Agent workflows

`WorkflowTool` runs a named JSON workflow from `.agenc/workflows/` or
`AGENC_HOME/workflows/`. Every manifest must declare `"format_version": 2` and
`"kind": "agent_dag"`. Unversioned DAGs and command-only manifests are
rejected; `WorkflowTool` has no alternate manifest reader or shell-command
execution path.

This DAG is `runtime/src/agents/workflow-*.ts`. `runtime/src/workflow/` is the
separate M5 verified-change pipeline (`agenc run start`). CSV batch jobs are
another surface (`agents.md`). Do not mix the three.

Invocation schema: required `name`, optional `args.max_concurrency`,
`args.max_handoff_tokens`, `args.failure_policy`. Per-step optional
`agent_type`, `model`, `task_name`, `isolation` (`none` \| `cwd` \| `worktree`).
Spawn isolation on children is `none` \| `worktree`.

## Manifest

Use structured references so step IDs and group names never share an ambiguous
namespace. `after` declares ordering dependencies. `inputs` gives downstream
messages local aliases for committed handoffs:

```json
{
  "format_version": 2,
  "kind": "agent_dag",
  "description": "Implement and review independently",
  "max_concurrency": 8,
  "max_handoff_tokens": 4096,
  "failure_policy": "continue_independent",
  "steps": [
    {
      "id": "implementation/arbitrary logical id",
      "message": "Implement the approved change.",
      "group": "changes"
    },
    {
      "id": "review",
      "message": "Review the implementation supplied as input prior.",
      "after": [{ "step": "implementation/arbitrary logical id" }],
      "inputs": {
        "prior": { "step": "implementation/arbitrary logical id" }
      }
    },
    {
      "id": "summary",
      "message": "Summarize the change group supplied as input set.",
      "inputs": { "set": { "group": "changes" } }
    }
  ]
}
```

Logical step IDs, group names, and `task_name` values are returned exactly as
data. They are never used directly as filesystem or agent-path components.
Input aliases must start with a letter and then contain only letters, digits,
`_`, or `-`.

### Child identity

The agent registry accepts only `[a-z0-9_]+` path segments
(`assertValidAgentName`). A logical id such as
`implementation/arbitrary logical id` would fail that check, so
`safeStepIdentity` in `runtime/src/agents/workflow-scheduler.ts` creates
the child name:

```text
wf_<ordinal>_<12-hex>
```

The digest is the first 12 hex characters of SHA-256 over
`agenc.workflow.step-path.v1\0<runId>\0<ordinal>\0<logicalId>`.
The scheduler passes this value as `agentName`, so `/agents`, the child
`agentPath`, worktree slugs, background-task `workflow:<name>` descriptions,
and step-handoff `producer_step_id` values use it. The ordinal prefix and
committed handoff connect the generated name to the manifest step. The digest
does not expose the logical id.

Group handoff producers use `safeGroupIdentity`:
`group_<index>_<12-hex>` from
`agenc.workflow.group-artifact.v1\0<runId>\0<index>\0<logicalName>`.
That string is the group handoff owner's `producer_step_id`, not an
`artifact_id` or a spawned agent. `WorkflowHandoffArtifactStore` derives the
separate `artifact_id` as `wh_<48-hex>` from the complete owner tuple and the
`group:<index>` idempotency key.

The M5 `agenc run start` path derives child names with
`workflowChildAgentName` in [cli.md](cli.md#run). It does not use this digest
format.

The graph is validated completely before any child starts. Duplicate or unknown
dependencies, self-edges, cycles, duplicate IDs, and step/group name collisions
are rejected. Ready steps run in stable declaration order, but a successor may
start as soon as its direct prerequisites commit; it does not wait for unrelated
slow work.

## Limits and artifacts

`max_concurrency` defaults to 16, accepts 1 through 64, and is further limited
by the shared agent registry. `max_handoff_tokens` defaults to 8,192 and accepts
1 through 32,768. Manifests allow at most 1,024 steps, 256 groups, and 65,536
expanded dependency edges. Whole-document byte, depth, JSON-node, string, and
message limits are validated before execution.

Each successful child output is published as a digest-bound
`workflow_handoff` artifact before consumers become ready. Consumers receive
artifact identity, digest, and a deterministic bounded extract as untrusted
input; child content is not interpolated into workflow policy or template
syntax. A group is usable only when every member succeeds and its aggregate
handoff commits. Artifact quota, publication, or token-limit errors produce
`handoff_failed`; they never release dependent work with truncated content.

Provider text deltas are synchronously spooled to a private temporary file
before the runtime grows its display buffer. The spool retains only a bounded
UTF-16 boundary carry, writes fixed-size UTF-8 chunks, and is streamed into the
artifact publisher after the child completes. It resets when a provider attempt
restarts. Byte and token ceilings are enforced while deltas arrive; crossing a
ceiling aborts that child and produces `handoff_failed` without constructing a
full in-memory final message. The conservative token fallback uses the central
UTF-8 estimator on complete decoded segments, including split-surrogate
boundaries.

## Failures and results

The tool returns `workflow_result_version: 2`. Public SDK types for this
contract live in `packages/agenc-sdk/src/workflow-result.generated.ts`;
see [sdk.md](../sdk.md#workflow-result-generated-mirror) for the
marker-only generated-type check. Step and group outcomes are:

```text
succeeded
failed
cancelled
unknown_outcome
handoff_failed
blocked_dependency_failed
blocked_dependency_unknown
```

`operation_counts` exposes node transitions, edge consumptions, ready-queue
enqueues and dequeues, and launches. The ready queue is an append-only FIFO with
a moving cursor, so dequeue work remains O(1) and independent of queue width.

Run outcomes are `completed`, `failed`, `cancelled`, or `unknown_outcome`.
Unknown child effects take precedence because AgenC will not invent proof that
an interrupted agent did or did not act. A failed, cancelled, or handoff-failed
prerequisite blocks descendants as `blocked_dependency_failed`; an unknown
prerequisite blocks them as `blocked_dependency_unknown`.

`continue_independent` is the default failure policy and lets unrelated branches
finish. `fail_fast` stops admission after the first non-success and requests
authoritative cancellation of active peers. Cancellation causes are
`user_abort`, `workflow_deadline`, `daemon_shutdown`, or `fail_fast_peer`.

Workflow scheduler state is intentionally non-resumable. A daemon crash makes
the outer workflow effect unknown and no child step is replayed automatically.
Operators may inspect committed handoffs and child evidence, then start a new
workflow only as an explicit reviewed action.
