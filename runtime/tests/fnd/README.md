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

## Shared fixture catalog

Foundation tests load the corpus through `openFndFixtureCatalog()`. The loader
pins the manifest digest, inventories the tree twice, rejects links and
unmanifested payloads, reads regular files through identity-bound descriptors,
rechecks the manifest, and returns private immutable snapshots. Tests that need
files should use the catalog's bounded `materialize()` contract rather than
copying fixture paths directly into an ordinary temporary directory.

Run the focused cross-runtime contracts with Node 26.5.0 and Bun 1.3.12:

```sh
npx vitest run runtime/tests/fnd/fnd-fixtures.test.ts
bun test runtime/tests/fnd/fnd-fixtures.bun.test.ts
```

Repository helpers, red probes, the isolated helper runner, and benchmark
harnesses land in their separately reviewed foundation PRs. Production parsers
must not import these test-only helpers or the fixture corpus.

See [the fixture contract](fixtures/README.md) for byte-preservation rules.
