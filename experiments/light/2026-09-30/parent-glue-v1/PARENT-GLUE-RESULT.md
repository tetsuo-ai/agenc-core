# Parent/owner glue checkpoint — 403da

This is an incremental source integration checkpoint, not a real CLI run.

HIGH implemented `owner-caller.ts`: after the existing immutable selection
guards, snapshot the trusted parent's complete callback tuple before dynamic
imports, validate the selected material/workspace, construct the existing
callback factory, and pass the same material to the real foreground entry.
The caller neither initializes a financial root nor creates an ACK, accounting
settlement, readiness proof or finalization authority. Failed attempts are not
retried inside the same process. All existing launch approvals remain false.

XHIGH found a narrow ordering issue in first draft `c816a994…`: source pins were
checked by the foreground only after factory imports/ledger reads. Root moved
the existing `verifyCompatibleSources` call before those imports. Corrected
caller SHA256: `f7bab3b8297f0bbdae0418dbc451da178741f47ce0f2924c9369f6888011bff0`.

Validation:

- Original combined caller/bridge strict type gate 37003 / 5749ec: exit 0.
- Corrected strict `tsc --noEmit -p tsconfig.companion.json`, including caller,
  callback factory and current identity bridge: 46578 / 91e9c0, exit 0.
- Network-denied ordering unit 01f2eb: 1/1 pass, zero skips. Synthetic selection
  and platform are explicit test doubles. A source-pin refusal occurs before
  any callback/Core dynamic import, and a second call is refused as already
  attempted. This is not Linux, financial or actual-client execution evidence.

The explicit `real-parent-adapters-v2` successor selects full revision 403da.
Root independently compared both adapter/loader files byte-for-byte with v1
(8d7c6f), verified the pins diff changes only the revision, and checked all five
pins against immutable current source (e36733). The bridge exports the same ten
canonical APIs through the selected source alias. Identity/PID/authentication/
instance-bound shutdown mechanics are unchanged; old ec45 artifacts are retained.
Read `CURRENT-IDENTITY-ADAPTER-REVIEW.md` for scope and exact canonical sources.

Neither caller nor bridge has been built into a new executable or launched.
The v3 package output is unchanged. Before actual integration, select the Linux
toolchain/native/assets/CLI/observer closure and private environment, run the
independent preflight in an owned process, retain its material after shutdown
and process close, and establish immutable owner selection before owner startup.
The actual parent still must own ordinary sibling CLI execution, authenticated
readiness/shutdown, child close and ledger/publication reconciliation.

SSH 43953 / cfdc3c timed out before authentication again. No remote command ran;
remote process state is unknown. No paid calls, repeated benchmark cells,
selection activation, deployment, merge or release occurred. Matched Light/Pi
quality and performance evidence remains missing.
