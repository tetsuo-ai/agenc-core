# FND algorithm baselines

This directory contains the FND-001 deterministic microbenchmark harness and
the checked-in observation of AgenC's audited CSV scheduler and patch parser
failure modes.

The baseline is deliberately not a performance gate. Every case is classified
as `known_failure_observation`, has `gateEnforced: false`, and has no threshold.
Future fixes must add separate correctness/resource/asymptotic gates; they must
not relabel these known-bad measurements as passing. Fixed observations leave
this active plan instead. Their original evidence remains available at the
artifact's recorded source revision and in Git history.

The catastrophic-regex observation was retired by D1 when grep became pinned
and fail-closed; its replacement regression coverage lives in
`tests/tools/system/grep.test.ts` and the D1 red-probe transition. The daemon
fuzzy-scaling and TUI query-truncation observations are retired by D2. These
observations are not converted into passing benchmark thresholds. The D2
replacement gates are ordinary revert-sensitive tests in
`tests/fnd/fuzzy-search-regression-gates.test.ts`: a literal full-query oracle,
the exact optimal/degraded memory boundary, and deterministic comparison-read
growth across geometrically increasing candidate lengths. The broader matcher,
persistence, cancellation, and 10,000-candidate checks remain in
`tests/search/fuzzy-match.test.ts` and `tests/app-server/fuzzy-file-*.test.ts`.

## Isolation and measurement

- Each case and input point runs in a fresh child process under an external
  deadline. Linux workers use the production cgroup/subreaper boundary;
  Windows workers are created inside the production Job Object broker before
  target launch; Darwin retains its process group plus observed descendant
  identities. A successful worker flushes an authenticated completion record
  and remains alive until the supervisor initiates contained teardown. Forced
  termination has a separate bounded settlement deadline. On Linux and
  Windows, timeout, output-limit, residual-process, or normal-exit handling does
  not settle successfully until the ownership boundary reports quiescence. On
  Darwin, the supervisor confirms that the process group and every descendant
  identity it observed are gone, but cannot prove containment of a process that
  forks, calls `setsid`, and reparents entirely between observation snapshots.
- The supervisor creates and owns every temporary root before launch, passes it
  to the child, and removes it after exit even when setup times out before the
  worker can emit its start record. If recursive settlement cannot be proven,
  cleanup fails closed: the root is retained and its exact path is reported for
  operator inspection instead of being deleted under a possibly live process.
  Automatic cleanup is bound to the original directory device/inode identity
  and refuses a missing or replaced pathname. Manual cleanup of a reported
  retained path is an explicit operator action rather than an automatic proof.
- Fixtures are deterministically generated after the case is selected. No
  checked-in bulk corpus, repository content, user path, prompt, or transcript
  becomes benchmark input.
- The runner requires an empty direct Node `execArgv` and rejects every
  nonempty ambient `NODE_*` or `TSX_*` entry, case-insensitively. These are
  reproducibility checks against visible runtime controls, not a security
  boundary: code requested by `NODE_OPTIONS` can execute before the runner can
  inspect the environment. Workers receive a fixed, minimal environment with
  no inherited home, path, provider key, or other secret-bearing variable.
  `AGENC_HOME`, `TEMP`, `TMP`, and `TMPDIR` all resolve to the supervisor-owned
  per-worker root, so workers never share the ambient temporary namespace.
  Windows carries only the case-insensitively matched `SystemRoot` value needed
  by the worker; libuv's finite required-variable set is removed before
  validation and before any measured production module loads. `tsx` uses no
  ambient TypeScript config or disk cache.
- Git, ripgrep, npm-version, and other metadata commands run through the same
  production process-containment boundary with a minimal locale/PATH bootstrap
  and no inherited home, provider, wallet, or cloud credentials. A referenced
  outer supervisor enforces a hard deadline; Linux and Windows retain detached
  descendants even when a target ignores `SIGTERM`, while Darwin carries the
  observed-descendant limitation above. On Windows, Git is resolved to a
  canonical regular file from a bounded `PATH`, in directory order with
  `.com` before `.exe`; the checkout directory is never an implicit executable
  source. npm metadata resolves only from fixed layouts beneath the canonical
  current Node installation and ignores ambient `npm_execpath` injection.
- Setup and index construction happen before warmup and timed samples. Completed
  cases report five or more measured samples.
- Elapsed time uses `performance.now()`. Operation counts are exact where the
  current implementation exposes a direct count and otherwise carry an
  explicitly named upper bound.
- Completed workers report the process high-water RSS from
  `process.resourceUsage().maxRSS`, normalized from KiB to bytes. Endpoint RSS
  samples remain a separately labeled lower-bound diagnostic. A synchronously
  blocked worker that is forcibly terminated cannot emit its final high-water
  mark, so that point records an unavailable peak plus its last start-RSS lower
  bound instead of presenting the lower bound as a peak.
- The complete tracked `runtime/src` tree is bound to its exact Git tree object
  at the recorded ancestor revision. Capture rejects staged, unstaged, ignored,
  or ordinary untracked production-tree files before and after measurement.
  The loader records the exact production-module closure actually loaded by
  every case, including transitive imports. Those modules carry immutable Git
  blob bindings and are compared with the current checkout by `--check`;
  unrelated `runtime/src` changes do not stale the historical observation. Git
  metadata commands strip ambient repository, index, object, and config
  overrides. Separate LF-normalized SHA-256 bindings cover checkout attributes,
  the worker, fixture generator, environment policy, loader tracker, contract,
  supervisor, provenance code, runtime manifest, and lockfile.
- This observation assumes a quiescent, trusted checkout. The endpoint checks
  reject changes visible before or after execution, but cannot detect a file
  that another actor mutates, executes, and restores entirely between those
  checks. Git and the `PATH` used to resolve it, Node, npm, `tsx`, installed
  `node_modules`, ripgrep, the native compiler, and the host system toolchain
  are trusted inputs. The artifact is bounded reproducibility evidence, not a
  cryptographic attestation of every byte executed by the host.
- macOS injects `__CF_USER_TEXT_ENCODING` while starting a process even when the
  supervisor supplies a minimal environment. The case worker accepts only the
  bounded hexadecimal CoreFoundation form and removes it before loading any
  measured production module; every other inherited name remains an error.
- Windows process creation similarly restores libuv's documented required
  variables when they are absent. The case worker removes the finite injected
  set before its exact allowlist check; unrelated inherited names remain an
  error.
- Baseline and evidence files are opened with no-follow and nonblocking flags
  where the platform exposes them, then type-, size-, and identity-checked
  through one bounded descriptor before and after reading. Reads allocate only
  the named ceiling plus a one-byte overflow probe and reject pathname swaps,
  links, special files, growth, and oversized inputs.

## Named fixture bounds

| Case                     | Bounded generated inputs                                                  | Child deadline |
| ------------------------ | ------------------------------------------------------------------------- | -------------: |
| CSV scheduler/progress   | at most 4,096 rows and 524,288 generated bytes                            |           45 s |
| Delete-only patch parser | at most 32,768 hunks and 2,097,152 generated bytes                        |           45 s |

Worker output is independently capped at 1,048,576 bytes. JSON output is capped
at 2,097,152 bytes and Markdown at 262,144 bytes. Metadata subprocesses have a
five-second deadline and bounded output. The harness does not contain a hidden
stress mode or accept caller-supplied fixture sizes.

Artifact publication creates both caller paths exclusively and never truncates
an existing file. If the second creation fails, the first is removed only after
its still-open descriptor and current pathname identity match; a replaced or
otherwise unprovable path is retained and reported. This makes failures clean
up the pair safely, but it does not claim impossible simultaneous visibility
across two independent filesystem pathnames.

## Commands

Use Node 26.5.0 and npm 11.17.0. Capture into temporary paths so a local run
cannot silently replace the reviewed artifact:

```sh
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- \
  --source-revision HEAD \
  --output /tmp/agenc-fnd-baseline.v1.json \
  --markdown-output /tmp/agenc-fnd-baseline.v1.md

npm run check:fnd-benchmark-baseline --workspace=@tetsuo-ai/runtime
npm run benchmark:fnd-baseline --workspace=@tetsuo-ai/runtime -- --plan
```

`--source-revision` must resolve to an ancestor whose complete `runtime/src`
tree exactly matches the checkout. Use the topic's parent when the benchmark
harness and generated artifact are being committed together; this avoids a
self-reference while still binding every executed production dependency.

Compare runs made on the same pinned runtime and machine state. Review raw
samples, median absolute deviation, operation counts, and relative scaling.
Absolute wall-clock differences remain informative rather than gating until a
separate, platform-calibrated gate is justified.

`baseline.v1.json` is canonical JSON. `baseline.v1.md` is generated
deterministically from it, embeds the JSON SHA-256, records the reproduction
command, and summarizes machine/OS/CPU/RAM/filesystem, Node/npm, SQLite, and
ripgrep metadata. Source-checkout and temporary-fixture filesystems are recorded
separately because they may be different mounts.
