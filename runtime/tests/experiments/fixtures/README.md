# Recorded request and tool-output replay

`t016-recorded.json` contains the model responses and first-observed tool-result
bodies from FV's `fix1046-untimed-main-fast-T013-T016`, repeat 1 arms a and b
(main 2f0 and 1046). The sequences have 12 and 37 provider responses. SSE chunks are
assembled in index order; calls keep their recorded IDs, arguments and reasoning.

`t017-recorded.json` contains the same fields for repeat 1 of FV's
`fixdf592-untimed-main-fast-T013-T016-T017`, arms a and b (main 2f0 and df592).
These sequences have 14 and 26 responses. Their first requests match, but the
second command in the first model response differs before any tool results arrive.

Every replayed tool-message body must match its captured bytes. The sole explicit
exception is the old 1046 unknown `Read` receipt: its original fixture is retained,
and the test asserts the exact canonical suggestion introduced by df592 instead.
The fixture decoder removes the compact outer `AGENC_DATA` frame before returning
raw tool text, so replay does not add a second frame to the recorded output.

The replay does not execute the recorded commands or writes. It supplies recorded
outputs to tool implementations and compares every serialized request between
normal and fast loops using the same transcript and settings, including the
DeepSeek wire capability hints and replayed reasoning history. This isolates
runtime projection from stochastic model choices; it is not a new task grade or
a claim about resource equivalence. Exact-output mode excludes completion-gate
policy from this control. Recovery and actual file-edit guards have separate tests.
