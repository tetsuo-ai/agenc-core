# Agent workflows

`WorkflowTool` runs a named JSON workflow from `.agenc/workflows/` or
`AGENC_HOME/workflows/`. Version 2 is the canonical agent-DAG format. The
unversioned version-1 DAG reader remains for one compatibility epoch and emits
a migration diagnostic; new workflows should not use it.

## Version-2 manifest

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

The tool returns `workflow_result_version: 2`. Step and group outcomes are:

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
