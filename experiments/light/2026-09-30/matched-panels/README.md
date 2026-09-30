# Matched AgenC Light vs Pi panels

Operator experiment code, not a runtime feature. Each runner runs the same 12 tasks for AgenC Light (build 403da, Linux
gate build 38d63) and Pi 0.73.1 with the same model and settings, one cell at a time, the two agents' cells adjacent in
a seeded order, fresh clone and fresh home per cell. Task 12 is scored on code only for both agents.

| Runner | Change |
| --- | --- |
| matched-v1 | Successor of the historical Luna runner: no sandbox bypass, flags before `--` and the prompt, code-only task 12. Smoke: every `exec_command` denied headless (see agenc-core #2827). |
| matched-v2 | Light config allow rule for `exec_command`, `write_stdin`. Smoke: every command refused, no bubblewrap in the container (see #2828). |
| matched-v3 | Container with bubblewrap (seccomp/AppArmor/systempaths relaxed only for nested bwrap), startup bwrap probe. Luna direct API with the historical accounting observer `direct.mjs`. |
| matched-v3-ds / -sol | DeepSeek Flash via loopback key proxy; GPT-5.6 Sol via the owner's ChatGPT subscription proxy (unpriced). |
| matched-v4 (+ -ds, -sol) | `--tasks-dir`; Luna no longer sets `OPENAI_BASE_URL` (an explicit default made Light fetch `/v1/models` before its first request, 0.40-0.57 s). |

`audit_cells.py` checks every captured request (settings tuple, sandbox refusals, permission denials, usage), `summarize.py`
reports pass rates, totals and a task-clustered bootstrap for Light minus Pi, `build_report.py` renders the results page.
`bench-linux.mjs`/`guard.mjs`/`run.sh` profile headless startup against a loopback fake provider (launch to first
request about 1.24 s in the benchmark container).

Results at this checkpoint (`summaries/`): Luna x3 Light 33/36, Pi 34/36; DeepSeek Flash x1 Light 11/12, Pi 12/12
(Light fewer calls per task, -2.9 [-5.2, -0.6]); Sol x1 12/12 each. Time, tokens and cost are inside the uncertainty on
every model. One repeat is diagnostic only; no superiority claim. Raw evidence stays on the Linux host and in the private
Desktop archive; held-out tasks are not published here.
