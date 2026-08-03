# Agent mailbox metadata cutover

Status: E3b caller and protocol cutover. This document completes the rollout
described by the E3a foundation contract in
`docs/design/mailbox-metadata-contract.md`.

## Admission boundary

`runtime/src/agents/mailbox.ts` accepts only an authenticated
`ValidatedMailboxMetadata` handle on `Mailbox.send`. Authentication is an O(1)
private-identity check; the mailbox never enumerates, clones, serializes, or
invokes a property of an unbranded metadata value. Invalid metadata preserves
the existing public `SendResult` contract by returning `"dropped"` and reports
one closed-vocabulary reason through the internal `onInvalidMessage` callback.

Untrusted protocol input enters through `Mailbox.sendEncoded`. That method
accepts UTF-8 JSON bytes, applies the E3a decoder before admission, and forwards
the resulting authenticated handle. Validation failures return `"dropped"`.
`MailboxMetadataAbortedError` remains control flow and propagates to the caller.

Trusted producers use one of two explicit paths:

- `createMailboxMetadataRecord` builds a flat kind-tagged record from scalar
  field tuples.
- `createMailboxMetadata` exposes the operation builder for known nested
  schemas such as multimodal user input and worktree receipt evidence.

There is deliberately no raw-object adapter.

## Caller migration

The agent control plane, agent thread manager, V2 message tool, child run loop,
parent notification outbox, omission markers, and their tests now construct
authenticated metadata. Consumers call `readMailboxMetadata` once and treat the
returned graph as immutable owned data.

Inter-agent routing additionally requires the authenticated semantic kind
`inter_agent_communication`. A differently kinded handle is rejected before
mailbox admission, so ordinary callers cannot spoof interrupt, history-clear,
or MCP-refresh control records.

Owned arrays have null prototypes. Consumers therefore use numeric index loops
and create normal domain objects before passing multimodal input onward. They do
not call inherited array methods, spread owned arrays, or use `Object.values`.

The older `Session.mailbox` remains a separate compatibility surface with raw
record metadata. Agent code crosses that boundary only by reading an already
authenticated owned graph and passing it to the legacy session mailbox. No raw
session record is admitted into an agent `Mailbox`.

MCP refresh configuration is intentionally not copied into metadata. The
mailbox carries an ordered `mcp_refresh` control record, while the latest
arbitrary configuration stays on the `LiveAgent` control plane. This preserves
the previous latest-config-wins behavior without creating a generic object
serialization escape hatch.

## Accounting and compatibility

Mailbox envelope accounting combines exact primitive JSON envelope bytes with
the retained canonical metadata byte metric. Trigger input accounting walks
only the authenticated owned graph with an iterative bounded traversal. The
existing mailbox depth, passive-byte, trigger-byte, overflow, omission, and
protected-trigger rules remain independently authoritative.

Public message delivery remains synchronous and continues to return only
`"sent"` or `"dropped"`. Existing metadata field names and parent notification
shapes are preserved at their consumers. Structured text, image, and PDF input
is reconstructed into ordinary `LLMContentPart` values before entering the run
loop.

## Verification and rollback

Boundary coverage includes hostile proxies, unbranded handles, valid wire
decoding, exact and plus-one depth and byte limits, abort propagation, immutable
post-send accounting, and a manager-to-mailbox-to-run-loop multimodal round
trip.

Run the focused verification with:

```bash
cd runtime
node scripts/run-hermetic-vitest.mjs run \
  tests/agents/mailbox.test.ts \
  tests/agents/control.test.ts \
  tests/agents/thread-manager.test.ts \
  tests/agents/run-agent.test.ts \
  tests/agents/run-agent-mailbox.test.ts \
  tests/conversation/thread-manager.contract.test.ts
```

Rollback is one E3b commit. If rollback is required after a wire producer has
shipped, retain `sendEncoded` and the bounded decoder for compatibility; do not
restore reflective validation or raw-object admission at the agent mailbox.
