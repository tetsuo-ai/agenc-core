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

## Bounded temporary repositories

`BoundedTempRepository` snapshots hostile inputs before queuing work, uses the
same Unicode-15.1 portable path identity under Node and Bun, applies named
entry/file/aggregate byte ceilings, journals batch writes, and fails closed on
external filesystem or Git-metadata changes. Its deterministic test-only hooks
exist solely for revert-sensitive crash and rollback probes.

The helper detects stable external changes and changes injected at its explicit
test-hook boundaries. It is not an operating-system sandbox against a process
that continuously races filesystem operations with the same OS credentials.
Public cross-platform Node APIs do not provide conditional rename or unlink by
inode, so callers must use process/credential isolation when that adversary is
in scope. Directory rename is audited before and after commit but is not
presented as an atomic no-clobber rename on every platform.

Run the focused cross-runtime contracts with Node 26.5.0 and Bun 1.3.12:

```sh
npx vitest run runtime/tests/fnd/bounded-file-io.test.ts \
  runtime/tests/fnd/bounded-repository-git.test.ts \
  runtime/tests/fnd/bounded-repository-transaction-races.test.ts \
  runtime/tests/fnd/bounded-temp-repository.test.ts \
  runtime/tests/fnd/fnd-fixtures.test.ts \
  runtime/tests/fnd/portable-repository-path.test.ts
bun test runtime/tests/fnd/portable-repository-path.bun.test.ts \
  runtime/tests/fnd/fnd-fixtures.bun.test.ts
```

Red probes, the isolated helper runner, and benchmark harnesses land in their
separately reviewed foundation PRs. Production parsers must not import these
test-only helpers or the fixture corpus.

See [the fixture contract](fixtures/README.md) for byte-preservation rules.
