# Real observer / synthetic callback integration — 2026-09-30

Root read both frozen files completely, then ran `check-observer-integration.mjs
first` under an OS sandbox denying network. Result: process36920/output4004ad,
exit0; **one sequential test passed, zero skips**, covering three actual owned
children. This test uses the unchanged observer-v6, real policy/binding Python
checks, fresh synthetic ledgers, new callbacks, genuine IPC, and the reviewed
parent publisher reader/dispatcher. It never starts a Core/Pi client.

| Case | Admissions | Settlements | ACKs | Result |
| --- | ---: | ---: | ---: | --- |
| Positive cap | 1 | 1 | 1 | Complete known synthetic usage and charge |
| Credit exhaustion | 1 | 1 | 1 | Same complete known synthetic usage and charge |
| Changed task | 0 | 0 | 0 | Actual binding checker refused `task_prompt_hash_mismatch` before admission |

Both healthy cases reconciled 100 input / 20 output / 0 cached tokens and 20,000
synthetic nanodollars from the whole ledger. Request, response and receipt hashes
matched the actual observer ACK. This is synthetic accounting, not real spend.

All three children exited0, closed and disconnected their IPC, needed no kill,
left no pending owned operations, and reached journal quiescence. Parent lifecycle
and reconciliation remained non-authorizing: no finalizer/score token was issued.
The lifecycle's `pi` arm parameter denotes its existing direct-child topology
only; this is not a Pi run or evidence of a Light daemon's process topology.

Exact roots retained without deletion:

- `/private/tmp/cli-callback-observer-cQGTZZ` (positive cap)
- `/private/tmp/cli-callback-observer-s1uUGY` (credit exhaustion)
- `/private/tmp/cli-callback-observer-o2Nz01` (changed task)

`observer-check-first/` retains the test output, selected hashes and result.
Child SHA-256: `0e4d4b5b3906c89a34488682ddd0ebb358d1d8ba3a8e82a2eb0fd19729f28e84`.
Test SHA-256: `42534f2104fdb1adb74b736d5fd9bbee6909b4148a016d1cfa8ac03cc79062b5`.
All selected inputs stayed unchanged during execution.

The root declaration and request content are explicitly synthetic. Canonical
independent preflight material, full client admission/identity, Linux deployment,
ordinary daemon startup and a fair current Light/Pi comparison are still pending.
