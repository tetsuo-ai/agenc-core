# Claude subscription qualification — 2026-09-22

## Result

The opt-in official Claude CLI transport works with the authenticated subscription
and the real AgenC daemon. Nine completed live scenarios produced **132 successful
tool calls**, with matching durable results, exit code 0, exact fixture assertions
and verified completion gates. No credentials are recorded here.

The overall qualification is **not all green**. The live browser exercised all
12 actions without a tool error, but its completion verification repeated work
and triggered the no-progress backstop. Full runtime and desktop suites also
reported failures. Catalog validation is not a claim that all tools were called
live. This remains an isolated experimental build, not a production rollout.

## Real Claude / daemon evidence

| Scenario | Calls | Evidence |
| --- | ---: | --- |
| Read, write and shell execution | 7 | [daemon](daemon-validation.json) |
| PNG attachment: exact random visual code | 8 | [image](image-validation.json) |
| Raster PDF attachment: exact random visual code | 8 | [PDF](pdf-validation.json) |
| FileRead, Write, Glob, Grep, Edit and shell | 12 | [file tools](file-tools-validation.json) |
| All six agent lifecycle tools, including a second task | 19 | [agents](agents-validation.json) |
| Concurrent children and closing a running child | 33 | [agent stress](agent-stress-validation.json) |
| Conversation resume after daemon restart | 11 | [resume](resume-validation.json) |
| Real stdio MCP fixture returning pong | 9 | [MCP](mcp-validation.json) |
| Task board, notebook read/edit, cron create/list/delete | 25 | [workflow](workflow-validation.json) |
| Browser: 12 distinct actions; session completion failed | 28 | [browser](browser-validation.json) |

The attachment codes were absent from prompts and filenames. The PDF contained
a raster image, not a text layer. The fixture independently checked output bytes;
neither attachment was read via FileRead. The lifecycle run exercised spawn_agent,
list_agents, send_message, wait_agent, assign_task and close_agent. Stress receipts
show closing children whose previous status was running. Cron fixtures were
non-durable, scheduled in the future and deleted during the test.

Browser actions: navigate, snapshot, type, press_key, click, get_text, screenshot,
scroll, new_tab, tabs, select_tab and close_tab. All 28 calls in that session have
successful matching results, but the client exited 1 after verification repeated
actions. This is a recorded failure, not a passing end-to-end browser session.

The browser fixture explicitly used `no_sandbox=true` for Chromium, inside the
retained AgenC workspace-write OS sandbox. Default nested Chromium sandbox launch
failed on this host. No global browser default was changed. Six live backend tests
pass with this fixture configuration; six fail with default nested sandboxing.

## Automated results

[Suite results](suite-validation.json) retain counts and failure details.
[Tool coverage](tool-coverage.json) maps all **81 registered tools** to schema/name
round-trip checks and actual live receipts. Tools without receipts have no live
execution claim. These are separate runs with overlapping tests; do not add their
counts as unique tests or treat retries as a fresh full-suite pass.

| Run | Passed | Failed | Pending |
| --- | ---: | ---: | ---: |
| Full runtime suite | 26,845 | 26 | 2 |
| Retry failed runtime files, excluding benchmark guard files | 346 | 7 | 0 |
| Full desktop suite | 2,874 | 47 | 24 |
| Retry failed desktop files after dependency/display repair | 57 | 5 | 0 |
| Latest affected runtime regression selection | 195 | 0 | 0 |
| Browser backend with workspace-write confinement | 6 | 0 | 0 |
| Browser backend with default nested Chromium sandbox | 0 | 6 | 0 |

Remaining runtime failures concern cron warning expectations, SDK/protocol tests,
socket timing and memory extraction. Benchmark guards also reject the modified
worktree/source baseline; the baseline was not regenerated to hide this.
Remaining desktop failures concern native maximize under the virtual display,
provider discovery expectations, local-model first-run behavior, protocol drift
and a layout tolerance. Full failure messages are in the suite artifact. Some
reporter aggregate counts differ from the number of listed failed assertions;
the artifact preserves the original counts and individual entries.

Runtime build, runtime and test-support typechecks, generated SDK type verification
and `git diff --check` passed. Additional affected selections (137, 541 and 212
passing tests) and earlier provider/bridge validation are recorded in the artifacts
and preceding probe evidence. Desktop source was not edited.

## Defects corrected during qualification

- PDF projection now omits AgenC-only attachment metadata before the native request.
- Notebook permission adaptation preserves signed-root metadata while removing
  FileRead-only aliases rejected by strict notebook schemas.
- TaskCreate/TaskUpdate declare their runtime-owned task-store effects correctly.
- Linux browser CDP channels survive the sandbox launcher boundary using dedicated
  stdio forwarding after confinement. Incompatible network profiles fail closed.
- Browser config/cache paths use the granted private profile; bounded startup
  diagnostics are retained. Unsupported keys are rejected before browser effects.
- Test environment scrubbing includes subscription controls and OAuth credentials.
- MCP project, nested-agent identity and browser lifecycle fixtures match current
  runtime contracts. Missing node-pty/desktop dependencies were repaired locally.

## Reproduce

Run from this worktree using Node 26 and the existing official Claude login:

```sh
node runtime/experiments/claude-subscription/daemon-probe.mjs
node runtime/experiments/claude-subscription/daemon-probe.mjs --image-test
node runtime/experiments/claude-subscription/daemon-probe.mjs --pdf-test
node runtime/experiments/claude-subscription/daemon-probe.mjs --file-tools
node runtime/experiments/claude-subscription/daemon-probe.mjs --agents
node runtime/experiments/claude-subscription/daemon-probe.mjs --agent-stress
node runtime/experiments/claude-subscription/daemon-probe.mjs --resume-test
node runtime/experiments/claude-subscription/daemon-probe.mjs --mcp
node runtime/experiments/claude-subscription/daemon-probe.mjs --workflow
node runtime/experiments/claude-subscription/daemon-probe.mjs --browser
```

The browser command retains the strict exit/completion assertions and therefore
fails if the recorded repetition recurs. Fixtures use isolated daemon state,
synthetic files and explicit tool permissions, then clean up their resources.
Attachment fixtures need Pillow and DejaVuSans; browser uses local Chrome.
Subscription billing attribution was not inspected. The validated attachment
path is daemon CLI input; these results do not establish outgoing attachment
delivery or every desktop attachment interaction through Claude.
