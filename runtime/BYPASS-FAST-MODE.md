# One-shot bypass fast mode (work in progress)

A fresh print-mode run with `--dangerously-bypass-approvals-and-sandbox` uses the
short turn loop when relaxed one-shot durability is enabled. Set
`bypassFastMode = false` in configuration, or use `--full-durability`, to keep the
normal turn loop. Interactive, sandboxed and resumed sessions keep that loop.
The old `AGENC_EXPERIMENT_MINIMAL` environment variable has no effect.

The operator accepts loss of this run's buffered transcript on a process crash.
Successful shutdown writes the transcript, redacts persisted data, updates its
index and SQLite mirror, and completes deferred auxiliary setup and cleanup.
Tool/usage observations, buffered progress and effect-journal intervals are
published at the end of the short loop. Their intervals retain the actual tool
start/end times. Intermediate recovery checkpoints are absent in this mode.

The loop uses the complete tool registry, including tool discovery and newly
loaded tools. Commands use the ordinary process manager, output limits,
deadlines, cancellation and yielded-process support. Binary tool results and
large histories hand off to the ordinary context accounting/compaction path;
completed tools are not dispatched again. Small text requests use an incremental
byte bound with early handoff at half the context window.

Required permission instructions, attachments and model-facing history use the
normal request projection before each request. Session identity, plan/home
context and filesystem roots use the normal trusted authority helpers before
each tool invocation; model-supplied internal authority is stripped first.
Read-before-write and stale-read protections remain enforced. A deterministic
six-request comparison covers discovery, reads, replacement and editing using
exact serialized Chat Completions request bodies. This control uses exact-output
mode, which disables the normal completion gate; it does not establish parity
for every continuation or hook policy.

Remaining work before a shipping decision:
- Runs with spend or token caps currently hand off to atomic admission. The
  requested memory-only spending path is not implemented. Shared calendar caps
  must not be checked against a stale per-session balance.
- Final accounting/journal completeness and final transcript recovery need the
  full Linux gate and review. A final checkpoint adds no recovery capability to
  an already terminal one-shot run, so the short loop does not emit one.
- Live quality, paired locked timing and the full Linux suite are pending on the
  final candidate. The 3.95 ms experiment is not evidence of shipping parity.
