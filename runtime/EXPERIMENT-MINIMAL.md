# Minimal command loop floor experiment

`AGENC_EXPERIMENT_MINIMAL=1` deliberately removes runtime guarantees to measure
JavaScript overhead. This branch is not a merge candidate. Use only disposable
bypass-mode sessions. The default path is unchanged; only the exact value `1`
enables the experiment. The switch is process-wide, including daemon sessions.

First cut: admission, effect journal, reservation/count_tokens accounting,
checkpoint hashes, durable secret redaction, usage aggregation, periodic and
explicit persistence barriers, and rollout SQLite mirroring are skipped.
Rollout records are buffered in memory until the store closes. Process crashes
lose the buffer. Recovery, accounting, durable visibility, and secret protection
are intentionally invalid. Normal session metadata/setup may still write at
startup; this experiment measures response-to-next-request command gaps.

Subsequent cuts and measurements are recorded in round3/jobs/rx/REPORT.md outside
the repository. Do not treat a successful fake-provider echo workload as proof
of general agent correctness or safe shipping behavior.

Second cut: a direct command-only turn loop resolves tools/provider options once,
then calls the provider adapter and unified exec manager directly. This omits
per-step history snapshots and hashing, tool routing/preflight/hooks, permission
and sandbox policy, intermediate event publication, compaction, attachments,
recovery and loop/budget checks. Only exec_command and write_stdin are supported;
other tool requests fail explicitly. Provider reasoning replay and real command
output are retained. History is buffered at turn completion and written on close.

Third cut: auxiliary setup deferred by the Light print startup wrapper is dropped
(thread projection, skills watchers, sidecars and its request fsync journal).
The chat-completions adapter also skips diagnostic prompt-token estimation,
context fitting and request-metadata publication. The real provider wire builder
and transport still send every request.
