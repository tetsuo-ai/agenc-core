# Native Windows overlay redraw audit

The reported panel-text residue was not reproduced on `origin/main` at
`eb8124420778ff38ff1e5839c037c3457a28b09e`. All 25 verified panel closures cleared
their panel text in a native Windows ConPTY. Twenty-four closed screens matched
a subsequent Ctrl-L redraw exactly. One comparison differed only in the footer,
as described below. No renderer or overlay-close change is proposed.

## Environment and execution

This audit ran on Windows 11 Pro x64, build 26300, using native Node v24.22.1,
npm 11.19.1, node-pty 1.1.0, and xterm/headless 6.0.0. The new worktree was created
from the freshly fetched main branch. `npm ci --foreground-scripts` and
`npm run build` both exited 0. The build verified its package entrypoints and
committed SDK types.

The local setup required `npm_config_force=true`: the checkout requires Node
`>=26.5.0 <27.0.0` and npm 11.17.0. The installed .NET Framework compiler also required
omitting `/deterministic+` and `/pathmap` from the Windows broker build locally.
Those edits were restored and are not part of this change.

The actual built `runtime/dist/bin/agenc.js` ran through node-pty with
`useConpty: true`, at 120 columns by 40 rows and 80 columns by 24 rows. Each run
owned private HOME, USERPROFILE, AGENC_HOME, application-data, temporary and
managed-home directories under `C:\Users\sa\agenc-swarm`. The repo's TUI gate
utilities created and stopped each private daemon. Its startup announcement was
used for readiness because repeated five-second `daemon status` probes timed out
on this host even after the daemon announced readiness.

The only injected provider credential was the dummy string `sk-sw2-fake-key`.
DeepSeek used `http://127.0.0.1:9/v1`. No model prompt was submitted. The isolated
configuration selected `danger-full-access` and disabled provider outage waiting.
No installed AgenC or operator configuration was used.

## Screen comparison

The harness replayed the output of the native ConPTY through xterm/headless to
capture the visible screen. This is terminal output processed by the Windows
console host, not a mocked React render. It is not a photograph of Windows
Terminal, and the SSH transport from the original report was not exercised.

Each slash command was typed, its completion popup dismissed, and Enter sent.
The harness waited for the requested panel's identifying text before capturing
the open screen. Escape closed `/status`, `/effort`, `/providers`, and the `?`
shortcuts overlay. `/model` required Escape to return from DeepSeek's model list
to the providers hub, followed by a second Escape to close the hub.

After each close, the harness captured the screen, sent Ctrl-L, and compared the
new screen. Comparisons include every cell's character, width, foreground and
background color mode/value, bold, italic, underline, inverse and dim attributes.
An empty single-width cell and a written ASCII space are equivalent visible
blanks. Text snapshots remove only trailing ASCII spaces. No footer rows or
other content are excluded from comparisons.

| Panel | 120x40 | First 80x24 | Three more 80x24 passes |
| --- | --- | --- | --- |
| `/status` | 0 changed cells | 0 | 0, 0, 0 |
| `/effort` | 0 | 6 footer cells | 0, 0, 0 |
| `/model` | 0 | 0 | 0, 0, 0 |
| `/providers` | 0 | 0 | 0, 0, 0 |
| `?` shortcuts | 0 | 0 | 0, 0, 0 |

All 25 open captures contain their expected panel marker, and all 25 closed
captures lack that marker. All 15 additional comparisons waited three more
seconds after closing, saving both the earlier and later closed screens. They
matched the fresh redraw exactly.

The initial 80x24 `/effort` comparison had six differing cells on row 24:
`ctx 0% ·` appeared in the footer by the redraw capture. No effort title, choices,
border or help text remained. This difference is retained in the evidence. The
footer derives context usage from daemon snapshots that are polled every five
seconds (`state/daemonWorkerTasks.ts` and `components/App.tsx`). An asynchronous
snapshot update is a plausible explanation, not a proven diagnosis. The later
15 comparisons did not reproduce this mismatch.

Early attempts are excluded from the 25 comparisons: one launch preceded build
completion, one readiness check expected an outdated prompt label, one daemon
status probe timed out, and an exploratory run did not wait for panel titles.
Its apparent blank-cell differences were not visible residue. Their raw local
records are retained separately under `SW2-evidence`.

## Reproduction and retained evidence

[Structured captures](windows-overlay-redraw-2026-10-23.json) include the native
environment, exact input timestamps, open/closed/redrawn text screens, cell
differences, and SHA-256 hashes of the original ConPTY streams. Original cell
arrays and raw streams remain in the test workspace under `SW2-evidence`.

The [audit driver](windows-overlay-redraw-2026-10-23.mjs) retains the final capture
procedure. It derives the checkout and its parent workspace from its location,
creates private state beneath that workspace, and uses the repo's node-pty.
Install the additional capture dependency outside the checkout:

```powershell
# In the isolated setup environment, with HOME and AGENC_HOME under the workspace.
npm install --prefix C:\Users\sa\agenc-swarm\SW2-tools --no-audit --no-fund @xterm/headless@6.0.0
node .\docs\eval\windows-overlay-redraw-2026-10-23.mjs audit-120x40 120 40
node .\docs\eval\windows-overlay-redraw-2026-10-23.mjs audit-80x24 80 24 3
```

The driver is a diagnostic recorder. It records nonzero cell differences rather
than treating every changing application fact as overlay residue. Readiness and
launch failures exit nonzero. The recorded runs used the workspace copy
`SW2-conpty.mjs`; the committed copy changes path resolution and pins its temp
parent inside the workspace. Its syntax was checked with `node --check`.

No production code, dependencies, keybindings, provider behavior or regression
tests changed. A renderer fix and failing-before regression would require a
reproduction of the reported residue. This evidence establishes the result for
this build, these terminal sizes and direct ConPTY; it does not rule out an
SSH-specific or different-build failure.
