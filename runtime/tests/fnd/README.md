# Foundation contract tests

This directory owns the immutable synthetic fixtures that freeze the audited
failure modes behind the foundation work. The fixture manifest records the
audited commit, exact byte length, and SHA-256 of every payload. Tests must
read payloads as bytes before choosing a parser.

## Red-probe policy

A defect probe uses the suffix `*.red-probe.ts`, which keeps it outside the
default `*.test.ts` and `*.test.tsx` discovery patterns. A later green
meta-runner executes each probe in an isolated process and requires both a
nonzero exit status and the exact registered defect fingerprint. Do not use
`skip`, `todo`, `test.fails`, or an assertion whose success means the unsafe
behavior remains present.

Hang probes require a supervisor deadline and heartbeat. When a defect is
fixed, promote its assertion into an ordinary test and verify that reversing
the functional change in a disposable worktree makes that test fail.

This foundation change adds no probes, helper runner, benchmark, or production
parser. Those arrive with the implementation task that owns the behavior.

See [the fixture contract](fixtures/README.md) for byte-preservation rules.
