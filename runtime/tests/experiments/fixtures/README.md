# T016 request replay

`t016-recorded.json` contains the model responses and first-observed tool-result
bodies from FV's `fix1046-untimed-main-fast-T013-T016`, repeat 1 arms a and b
(main 2f0 and 1046). The sequences have 12 and 37 provider responses. SSE chunks are
assembled in index order; calls keep their recorded IDs, arguments and reasoning.

The replay does not execute the recorded commands or writes. It supplies recorded
outputs to tool implementations and compares every serialized request between
normal and fast loops using the same transcript and settings, including the
DeepSeek wire capability hints and replayed reasoning history. This isolates
runtime projection from stochastic model choices; it is not a new task grade or
a claim about resource equivalence. Exact-output mode excludes completion-gate
policy from this control. Recovery and actual file-edit guards have separate tests.
