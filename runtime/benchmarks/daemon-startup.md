# Daemon readiness with a large session history

The owner reported a 206-second delay after updating to 0.19.15. The synthetic
home reproduces the storage shape, not the owner's private transcripts or
provider initialization: 193 active runs, one completed run, 678 snapshots,
six project databases totalling 1,911,005,184 bytes, largest 1,283,969,024 bytes.
All payloads are generated text. Each active run has a canonical rollout and
journal binding. The runner is injected, with no provider or tool execution.
These runs lack a complete runtime environment and are published cold,
exercising the retained-source limit and publication of sessions that require
a later cold resume.
The daemon integration tests separately exercise actual restore orchestration,
four concurrent bootstraps, tool replay, cancellation, shutdown, and resume.

Measured on macOS 26.6.2, arm64, Node 26.8.1. Each run used a fresh isolated
HOME and AGENC_HOME. Both measurements enabled Node CPU profiling. Timings
start at foreground daemon admission after source-module imports; fixture
generation and imports are excluded. The before revision is
`bc43c6e4b5b374931de020364f2e0d267bd481a6` (0.19.15), with only phase timing
logs added. Results are single samples, not statistical claims.

| Measurement | Before | After |
| --- | ---: | ---: |
| Readiness published | 8,207.6 ms | 1,702.4 ms |
| First health RPC after readiness | 21.0 ms | 31.8 ms |
| First new agent creation | 33.4 ms | 83.0 ms |
| All 193 restores settled, from admission | 8,263.3 ms | 2,864.8 ms |
| Sessions still restoring at first health reply | 0 | 173 |
| Shutdown exit code | 1 | 0 |

Readiness improved by 79%. The after daemon accepts new work while old
sessions are still loading. The baseline shutdown failed with `Invalid string
length` when serializing transcript copies in recovery metadata; the after
summary contains references and recovery notices instead.

| Startup phase, summed across projects | Before | After |
| --- | ---: | ---: |
| Database open | 32 ms | 27 ms |
| Terminal retention | 2 ms | 3 ms |
| Per-session snapshot retention | 3,696 ms | 47 ms |
| Table snapshot retention | 929 ms | 10 ms |
| Space reclamation | 0 ms | 0 ms |
| Journal validation and snapshot loading | 2,250 ms | 1,468 ms |
| Execution admission recovery | 41.3 ms | 24.3 ms |
| Snapshot hydration before readiness | 1,110.9 ms | 0 ms |
| Snapshot registration before readiness | included above | 0.2 ms |
| Snapshot hydration after readiness | 0 ms | 1,114.0 ms |

Retention previously scanned large TEXT values to measure their length.
`octet_length(column)` reads SQLite's stored byte length without reading the
payload's overflow pages. It also enforces byte caps correctly for multibyte
text. The newest recovery snapshot is still retained. Loading and normalizing
latest snapshot payloads now happens behind each session's existing restore
gate. Canonical authority and admission recovery still finish before readiness.
Their cost depends on journal size; this fixture does not reproduce the exact
206-second incident. A full VACUUM was not needed in this fixture, so its
removal from startup contributes zero to these measured savings.

Run from the repository root:

```sh
benchmark_home=$(mktemp -d)
HOME="$benchmark_home" AGENC_HOME="$benchmark_home/agenc" \
  TSX_TSCONFIG_PATH=runtime/tsconfig.test-support.json \
  node --import tsx runtime/scripts/benchmark-daemon-startup.ts
```

The script creates a separate temporary home, prints its path and phase
timings, and writes `timing.json` and `daemon.log` there. It clears ambient
provider and authentication environment variables before starting the daemon.
Allow several GB of free disk space for SQLite and WAL setup. `BENCH_BYTES`
can reduce payload size for a smoke run while retaining all session counts.
The fixture directories are retained for inspection and can be removed after
copying the evidence. No existing daemon or user home is used.

No idle-session expiry policy was added. Existing terminal-run retention,
snapshot caps, canonical validation, cancellation repair, tool recovery
categories, descriptor limits, restore concurrency, and shutdown fencing stay
in force. Old databases without incremental auto-vacuum retain free pages;
startup no longer performs the full rewrite needed to convert them.
