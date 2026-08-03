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
prepared candidates. End-to-end build time is persistent generation
publication. End-to-end cold queries alternate non-extension queries; warm
queries time true extensions after an untimed base query. Stable query samples
must not call discovery. Invalidation latency begins at a healthy watcher event
and ends when a newer generation makes the changed sentinel visible.

The runner requires Node 26.5.0 and npm 11.17.0. It refuses staged, unstaged,
untracked, or ignored changes below `runtime/src` and in this benchmark
evidence directory, records both the exact commit and `HEAD:runtime/src` tree,
and gives workers only a small allowlist of
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
`null`. In particular, a one-million-entry
daemon point may truthfully expose the current 512 MiB cache ceiling.
