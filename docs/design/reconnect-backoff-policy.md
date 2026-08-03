# Finite reconnect and Retry-After policy

Status: E2 implementation, rebased onto `main` after A1 merged as
`0024f9e04` ([#1644](https://github.com/tetsuo-ai/agenc-core/pull/1644)).
A1's replay-admission semantics are already present and remain authoritative;
E2 preserves their unknown-physical-effect retry refusal.

## Compatibility contract

The transport reconnect defaults remain:

| Policy | Value |
| --- | ---: |
| Initial exponential capacity | 1,000 ms |
| Maximum exponential capacity | 30,000 ms |
| Maximum accepted provider floor | 300,000 ms |
| Live turn recovery reservations | 5 retries after the initial call |

E2 changes only how a permitted retry is delayed and how its finite budget is
accounted. The previous narrow plus-or-minus 25 percent interval is replaced by
integer full jitter over the complete exponential window. There is no implicit
elapsed deadline, but the API now requires at least one explicit finite bound:
total attempts or elapsed milliseconds. The live turn passes six total provider
attempts, while the shared A1 recovery reservation remains authoritative and can
stop it earlier.

## Delay rule

`runtime/src/recovery/reconnect-policy.ts` is a pure O(1) calculator. For retry
index `attempt`, it computes the exponential capacity with saturating arithmetic:

```text
expCap = min(maxDelay, baseDelay * 2^attempt)
```

Without a server directive, it samples an integer uniformly from the inclusive
range `[0, expCap]`. With a valid provider floor, it samples only the additional
component:

```text
jitterCap = min(expCap, remainingBudget - retryFloor)
delay = retryFloor + floor(rng() * (jitterCap + 1))
```

An RNG result must be finite and in `[0, 1)`. Invalid directives use ordinary
jitter. A syntactically valid floor is never shortened: a floor above 300,000 ms
or above the remaining elapsed budget exhausts with a typed reason before
another provider request.

## HTTP adapter boundary

`runtime/src/llm/retry-after.ts` owns RFC 9110 parsing at the provider HTTP
adapter boundary. It accepts nonnegative decimal delta-seconds and all three
HTTP-date forms, treating obsolete date forms as UTC independently of the host
timezone and normalizing their permitted `23:59:60` leap second. Only HTTP
optional whitespace (space and horizontal tab) is discarded at field edges;
Unicode whitespace remains invalid syntax. It rejects partial integers,
negative values, invalid calendar dates, weekday mismatches, non-finite spellings,
and unsafe integer overflow. The adapter returns one immutable classification:
`absent`, `invalid`, `valid`, or `over_policy`.

The parser follows [RFC 9110 section 10.2.3](https://www.rfc-editor.org/rfc/rfc9110.html#name-retry-after),
which defines Retry-After as either HTTP-date or nonnegative integer
delay-seconds. Valid over-policy values retain their actual floor for downstream
exhaustion; they are not clamped to an earlier retry.

## Elapsed and abort accounting

One immutable monotonic/wall start pair owns the entire reconnect call. Elapsed
time is the larger nonnegative delta. Monotonic progress survives ordinary wall
clock correction; a positive wall gap catches suspend on platforms whose
monotonic clock pauses; wall rollback cannot restore budget. Provider calls,
transient classification, the A1 retry-admission callback, timer wait, and timer
oversleep all consume the same window.

Abort is checked before each provider call, after a transient failure, before
and after the retry callback, before sleep, during the abortable sleep, and
immediately after wake. Telemetry contains only bounded numbers and closed reason
codes; raw provider error or abort text is not copied into reconnect warnings.

## A1 dependency and rollback

The live run-turn callback checks replay safety before reserving another ladder
entry. Side-effecting, interactive, or unknown-physical-effect streamed work
therefore remains non-retryable regardless of Retry-After or jitter. Delay policy
never decides retry eligibility.

The dependency order is merged A1, then E2. Integrate E2 only on a current
`main` containing #1644; there is no outstanding A1 rebase. Rerun the production
run-turn side-effect tests and the full host-functional suite after any later
rebase. Rolling back the E2 production commit restores the earlier delay
implementation without reverting A1 effect settlement or changing persisted
state.

The choice of full jitter follows the measured contention results in the
[AWS Architecture guidance](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
and the current [AWS retry behavior specification](https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html).
Run the local distribution and constant-cost evidence with:

```bash
npx tsx runtime/benchmarks/reconnect-full-jitter.ts --check
```
