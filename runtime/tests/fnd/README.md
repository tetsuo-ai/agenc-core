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

After A1, A2a, A3, B1, B3a, C1, C3a, D1, D3, and E1a promotion, the P0
inventory contains two task-owned defect probes plus the FND-001 harness
self-test, so the exact green audit summary is
`files=3 expected-red=3 assertions=3 skipped=0 todo=0`. Each
remaining task-owned
probe calls a production seam without a provider, public network, or
uncontained subprocess:

| Task | Current defect frozen red                                                                        | Desired assertion                                                                                                              |
| ---- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| A2b  | Startup returns a running agent whose bound canonical journal is corrupt.                        | The corrupt run is non-executable and absent from recovery results.                                                            |
| C2   | The compaction policy tells the summarizer to obey instructions embedded in transcript context.  | Transcript instructions remain untrusted and cannot alter compaction policy.                                                   |

Some production modules import repository-owned Markdown prompt assets. The
red-probe bootstrap admits only exact `.md` files under the canonical
non-symlink `runtime/src` root through a digest-pinned loader. It rejects path
aliases, escapes, links, nonregular files, invalid UTF-8, mutation, and files
over 256 KiB. The authenticated final record binds the loader digest, source
root, and the canonical path and SHA-256 of every loaded Markdown asset.

The FND-001 self-probe intentionally omits a required transition and proves the
harness itself goes red; it does not claim a product defect remains and does not
satisfy any task-owned P0 defect-probe gate.
The A1 timeout/physical-settlement assertion, A2a canonical-journal integrity,
A3 full-body tool-result digest, B1 prototype-header round trip, B3a confined
workflow-name traversal, C1 message-frame floor, C3a admitted memory recall and
lexical fallback, D1 pinned-ripgrep assertions, D3 byte-fidelity assertions,
and E1a recovery line-limit assertion are now ordinary regression coverage.
The two unresolved task-owned P0 probes remain registered alongside FND-001.
When another product defect is fixed, promote its assertion into an ordinary
test and verify that reversing the functional change in a disposable worktree
makes that test fail.

The hard per-probe deadline bounds authenticated bootstrap and cold static
imports. Trusted heartbeat sequence 1 seals the bootstrap capability boundary
before probe-owned imports; sequence 2 proves that the reviewed root runner is
loaded. Heartbeat-silence monitoring begins only at sequence 2 and remains
active through execution, while the independent hard deadline remains active
from process spawn.

Product hang probes must add task-specific progress evidence in addition to the
supervisor heartbeat; a silent timeout is not accepted as defect reproduction.

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

The isolated benchmark harness and reviewed known-failure baseline live in
[`../../benchmarks/fnd/`](../../benchmarks/fnd/). Red probes remain separate
from timing evidence so noisy wall-clock measurements never enter the default
test suite. The authenticated red-probe runner and containment contracts live in this
foundation layer. Production parsers must not import these test-only helpers, benchmarks, or
the fixture corpus.

## Process and restart helpers

`child-process-harness.ts` owns every child it starts and makes cleanup an
idempotent settlement barrier. Its invocation contract snapshots plain data
before asynchronous validation, pins the workspace and executable identities,
uses one end-to-end deadline, combines stdout and stderr under one byte quota,
admits at most eight aggregate active or preparing operations, and can require a
bounded heartbeat file. An operation retains its admission slot until caller,
child, and detached preparation work have physically settled. Cleanup joins
aborted or timed-out preparation and heartbeat-monitor work; a named two-second
settlement bound is reported as a cleanup failure only after the physical work
has been joined. Durable markers and heartbeats are declared before spawn, must
be absent at that boundary, and carry a fresh per-child nonce. Heartbeats begin
at sequence one and advance monotonically.
Portable path identities keep case, Unicode-normalization, and DOS 8.3 aliases
from conflating evidence boundaries. Evidence uses the shared bounded-file
reader, which pins singly-linked regular-file descriptors and verifies BigInt
identity, mode, size, modification/change time, and the post-read pathname;
paths must remain below the pinned temporary workspace. `forced` records actual
escalation past the initial process-tree termination request, independent of
heartbeat observation. Windows Job Object shutdown can settle the whole tree on
that initial request, while a POSIX signal-resistant child requires escalation.
The stop reason, tree-settlement proof, and escalation flag are authoritative;
Darwin may leave both optional child exit-status fields null after the detached
`process.execve` boundary has been proven absent.

`restart-harness.ts` keeps simulated exits distinct from forced process crashes
and requires two to eight successful recovery passes with one stable
fingerprint. Inspection callbacks receive an abort signal at their explicit
deadline and must physically settle within a second bounded interval; failure
to prove settlement rejects the scenario. The ordinary Node test exercises real
contained processes, the Bun test runs the same transition contract without
platform process APIs, and the native allowlist repeats fixture loading,
bounded descriptor I/O, portable path identity, termination, heartbeat, and
portable evidence admission on macOS and Windows. None of these tests uses a
skip or todo gate.

Run the focused checks from the repository root:

```sh
npm --workspace=@tetsuo-ai/runtime exec vitest -- \
  run tests/fnd/process-repository-helpers.test.ts
(cd runtime && bun test tests/fnd/process-repository-helpers.bun.test.ts)
npm run typecheck:test-support
```

The process helpers remain test-only; they do not replace production process
containment or add a production parser.

See [the fixture contract](fixtures/README.md) for byte-preservation rules.
