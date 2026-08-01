# CP-0001: Separate caller, admission, and physical-effect outcomes

| Field | Value |
| --- | --- |
| Status | Accepted target; implementation pending |
| Audit snapshot | `d2b228e87ea63bd6a5d93e6f599f36bce88d672b` |
| Audit date | 2026-07-31 |
| Owners | Effect-outcome state machine and retry audit (A1); consumed by CSV jobs, patch execution, recovery, and cancellation |
| Compatibility | Additive persisted evidence followed by a coordinated reader/writer cutover |

## Context

A caller deadline currently can be treated as a determinate tool failure even
after a physical effect may have been dispatched. That makes a late successful
write, send, or process launch eligible for a duplicate retry. Admission usage
and physical effect evidence also answer different questions and cannot be
collapsed into one status.

## Decision

AgenC MUST preserve three independent state dimensions.

1. Caller response records whether the caller received a result, timeout, or
   abort response.
2. Admission/accounting remains exactly `reserved`, `dispatched`,
   `reconciled`, `voided`, `held_unknown`, or `provider_overrun`.
3. Durable physical outcome remains exactly `committed`, `failed`, `cancelled`,
   or `unknown_outcome`.

A deadline is a caller observation. It is never, by itself, proof that the
effect did not occur.

### Cross-product contract

- A pre-dispatch denial or cancellation voids its reservation and creates no
  dispatched physical effect.
- Known usage with an ambiguous physical effect may be `reconciled` plus
  `unknown_outcome`.
- Unknown usage with a confirmed physical effect may be `held_unknown` plus
  `committed`.
- `cancelled` or `failed` after possible dispatch is valid only with typed,
  authoritative boundary evidence.
- Side-effecting or interactive `dispatched` evidence without a terminal or
  review record blocks retries and dependent mutation even if an explicit
  unknown record could not yet be appended.
- Impossible combinations MUST be rejected. No merged status enum may be
  introduced to conceal the distinction.

### Dispatch and settlement

Admission `dispatched` and the existing effect intent MUST be durable before
the effect boundary is crossed. If either required write fails, dispatch MUST
not occur.

At a deadline, the caller receives the typed timeout or abort response
promptly. A supervised settlement observer continues to own the admission
lease, process handle, and physical completion promise until authoritative
settlement. Caller cancellation requests physical cancellation but does not
release those resources early.

For side-effecting and interactive calls, the live identity is poisoned at the
deadline and a bounded durable unknown append is scheduled. Failure to append
that diagnostic cannot reopen the gate because the durable dispatched intent
already exists. Idempotent calls with a verified durable provider key remain on
their original attempt/key rendezvous path and do not enter a schema-forbidden
unknown state.

### Evidence and review

Existing `failed` and `cancelled` evidence gains a typed no-effect/boundary
field. No-effect may be asserted only before dispatch or by an adapter with
authoritative proof. Exception names, socket closure, missing acknowledgement,
and abort requests are not proof.

An unknown record remains immutable audit evidence. A later disposition is a
strict, versioned typed `review_resolution` record rather than a mutation of the
unknown record. It has `version: 1`, `kind: "effect_review_resolution"`, binds
the effect/review identity, and carries exactly one disposition:

- `confirmed_committed`;
- `confirmed_no_effect`; or
- `remains_unknown`.

It also binds `actor_kind` (`system_settlement` or `operator`), stable nonempty
`actor_id`, `evidence_kind` (`provider_receipt`, `idempotency_lookup`,
`boundary_not_crossed`, or `operator_evidence`), durable `evidence_ref`,
`evidence_sha256`, and `reviewed_at`. The review timestamp is persisted with the
resolution and cannot substitute for append order or evidence identity. System
settlement may use only authoritative adapter evidence. Logs expose safe
identifiers and digest prefixes, not evidence payloads.

Review workflow status is `pending`, `resolved`, or `abandoned`. Domain action
is separate, such as `mark_completed`, `retry_new_attempt`, or `abandon_item`.
Retrying a new attempt requires `confirmed_no_effect` or a verified durable
idempotency key. Abandonment retains `remains_unknown`.

## Migration and rollout

Readers and retry gates land before new evidence writers. Ambiguous legacy
state defaults to unknown, never failed/no-effect. Writers and every retry
reader switch in one merge-safe sequence. Each persisted boundary records its
format/minimum-reader requirement.

The cutover uses `run_effects.effect_format_version = 2` with minimum reader
runtime `0.14.0`. Schema migration v17 preserves every legacy review payload,
converts ambiguous non-idempotent v1 `failed` / `cancelled` rows to pending
`unknown_outcome`, and creates a verified pre-v17 database backup. Legacy
free-form review labels remain audit evidence but cannot lift the gate.

## Rollback

Rollback disables new dispatch or automatic retry while the minimum compatible
reader drains/reconciles existing observers. It MUST preserve unknown and review
evidence. It MUST NOT restore timeout-as-failure semantics or use an older
reader that can reinterpret the new state.

## Alternatives rejected

- Treating timeout as failure: it confuses response latency with effect truth.
- Releasing capacity when the caller stops waiting: it permits overlap with a
  still-running effect.
- One combined accounting/effect enum: it loses valid cross-product states.
- Retrying from human-readable error text: it is not authoritative evidence.

## Verification obligations

Property-test each machine and the allowed cross-product. Inject crashes before
and after intent, dispatch, acknowledgement, deadline, review, shutdown, and
restart. A concurrency-one test MUST prove that an abort-ignoring timed-out
effect retains its slot until physical settlement.

Primary references: [RIFL](https://web.stanford.edu/~ouster/cgi-bin/papers/rifl.pdf)
and SQLite's [atomic commit](https://www.sqlite.org/atomiccommit.html) guidance.
