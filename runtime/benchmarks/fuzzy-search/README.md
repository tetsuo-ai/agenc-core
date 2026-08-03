# D2 fuzzy-search benchmark

This committed harness measures the shared D2 matcher and the persistent daemon
index with deterministic synthetic path corpora. The full plan always contains
10,000, 100,000, and 1,000,000 paths in both `matcher_only` and `end_to_end`
modes. Generated paths, SQLite files, WAL/SHM files, and reports live only in an
owned operating-system temporary directory and are removed after each worker.

Run the full plan with the repository-pinned Node and npm versions:

```sh
npm --silent --workspace=@tetsuo-ai/runtime run benchmark:fuzzy-search > /tmp/agenc-d2-fuzzy.json
```

`--quick --check` runs a bounded 100/1,000-path contract smoke. Quick output is
not acceptance evidence. The full runner emits canonical JSON on stdout and a
compact table on stderr. It does not write beneath the checkout.

Each size/mode runs in a fresh process. Matcher build time is candidate
preparation; matcher cold queries receive raw strings and warm queries reuse
prepared candidates. End-to-end build time includes the production ownership
transfer into compact storage and persistent generation publication. End-to-end
cold queries alternate non-extension queries; warm queries time true extensions
after an untimed base query. Stable query samples
must not call discovery, and the first service load must hydrate the exact
published generation with zero discovery calls. Invalidation latency begins at
one healthy watcher event and freezes at the first service response for the next
generation, which must result from exactly one discovery. Polls must first
observe only the prior generation with no sentinel; the first newer response
must be the immediately following generation.
An unrestricted service response must contain the sentinel exactly once. A
truthfully resource-limited response may omit ranked files only when matcher
metadata reports the limit and aggregate freshness reports truncation. In both
cases, a direct `readCurrent` oracle must then bind the same N+1 persisted
generation, the complete entry count, and exactly one sentinel. Benchmark-only
oracle hydration, lookup, and collection are excluded from invalidation latency
and reported separately as `persistedOracleElapsedMs`. The report keeps service
and persisted counts separate and records the compact entry-store bytes beside
the unchanged production cache ceiling.

The runner requires Node 26.5.0 and npm 11.17.0. Corpus-v1 digests and logical
byte totals are frozen in the report contract for every quick and full size;
intentional generator changes require a reviewed version and descriptor update.
The runner refuses staged, unstaged, untracked, or ignored changes below
`runtime/src` and in this benchmark
evidence directory, captures both the exact commit and `HEAD:runtime/src` tree
before launching workers, and requires the clean identities to remain unchanged
after all workers. It gives workers only a small allowlist of
non-secret environment variables. Reports bind CPU/RAM, source and temporary
filesystem types, Node/npm/V8, the production SQLite version and compile
options, and the pinned-package ripgrep distribution/version. The parent owns
each worker's temporary directory, so timeout, crash, and output-limit paths
still clean up.

RSS fields are endpoint observations plus the process high-water mark. Index
bytes separately report logical path bytes, the open main/WAL/SHM files, their
sum, and the closed main database. A point may report `resource_limited`,
`timed_out`, or `failed`; the harness never bypasses production bounds or
fabricates unavailable latency or memory metrics; unavailable fields are
`null`. A validated full report is emitted before an acceptance failure returns
nonzero, preserving resource-failure evidence. Full acceptance nevertheless
requires every planned point to contain build, query, RSS, and index-byte
measurements, and requires every daemon point to prove the atomic watcher
invalidation through its persisted-store oracle. Matcher points and the 10,000
path daemon point must complete. The 100,000 and 1,000,000 path daemon points may
truthfully report `QUERY_RESOURCE_LIMIT` after all measurements and exact N+1
evidence are present; `failed`, `timed_out`, missing, or partial evidence is
never accepted.
