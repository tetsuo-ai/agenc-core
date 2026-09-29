# Light mode comparison harness

This Linux-only harness compares Pi, AgenC normal mode and AgenC Light using identical coding tasks and model settings. It measures actual provider-reported input, cached input, output, model/tool calls and wall time. It retains failed tasks, timeouts and incomplete usage. It does not claim a universal token or quality guarantee.

The suite has 12 tasks over fresh checkouts of two real repositories. Seven tasks introduce labeled synthetic regressions; the others cover a public multi-file feature with tests, a refactor, repository search, a shell script and deferred planning capability. Task definitions and hidden behavior checks are in `tasks/manifest.json` and `tasks/task_support.py`.

| Input | Pin |
| --- | --- |
| Pi npm package | `@mariozechner/pi-coding-agent@0.73.1` |
| more-itertools | [`790bb0bb2c03e7a07282e5f16f4b1fde35b8fcf5`](https://github.com/more-itertools/more-itertools/commit/790bb0bb2c03e7a07282e5f16f4b1fde35b8fcf5) |
| ItsDangerous | [`672971d66a2ef9f85151e53283113f33d642dabd`](https://github.com/pallets/itsdangerous/commit/672971d66a2ef9f85151e53283113f33d642dabd) |
| Primary models | `deepseek-flash`, `deepseek-v4-pro`; reasoning high; output cap 8192 |
| Optional secondary model | `gpt-6-luna`; reasoning low; output cap 8192; subscription cost unpriced |
| Validated runtime | Linux, Python 3.11.2, Node 26.5.0; image `node@sha256:219fc9da91e7f29a9f32290ff598cdf8886fd68f421ff515c8f93434da39a271` |

The image digest above was resolved from the local `node:26.5.0-bookworm` image during Linux validation. The runner records actual Node/Python versions, both Core Git revisions, Pi version, task/pricing/source hashes, randomization seed and limits. Pi uses its default `read`, `write`, `edit`, `bash` tools with an isolated configuration and no user extensions.

## Prerequisites and offline verification

Use Linux with Git, Python 3.10 or later, Node and npm. Build clean baseline and candidate Core checkouts using the repository's build instructions. Nothing here launches a Desktop app or Electron suite. Setup/check scripts use only Python's standard library; do not install pytest into task environments. The identical task prompts tell every agent what is available.

Set these example paths to task-owned directories. Do not use a personal AgenC home, Pi home or existing working repository as the output root.

```sh
HARNESS=/absolute/agenc-core/runtime/benchmarks/light-mode
BENCH_ROOT=/absolute/task-owned/light-comparison
CORE_BASE=/absolute/built-baseline-core
CORE_CANDIDATE=/absolute/built-candidate-core
PI_PREFIX="$BENCH_ROOT/pi"
mkdir -p "$BENCH_ROOT/sources"
npm install --prefix "$PI_PREFIX" @mariozechner/pi-coding-agent@0.73.1
git clone https://github.com/more-itertools/more-itertools.git "$BENCH_ROOT/sources/more-itertools"
git -C "$BENCH_ROOT/sources/more-itertools" checkout 790bb0bb2c03e7a07282e5f16f4b1fde35b8fcf5
git clone https://github.com/pallets/itsdangerous.git "$BENCH_ROOT/sources/itsdangerous"
git -C "$BENCH_ROOT/sources/itsdangerous" checkout 672971d66a2ef9f85151e53283113f33d642dabd
python3 "$HARNESS/test_runner.py"
python3 "$HARNESS/test_packaging.py"
python3 "$HARNESS/summarize.py" --self-test
python3 "$HARNESS/luna_bridge.py" self-test
python3 "$HARNESS/tasks/self_validate.py" "$BENCH_ROOT/sources" "$BENCH_ROOT/validation-fresh"
```

The validation directory must not already exist. The checker self-validation proves all 12 unsolved tasks fail, their reference solutions pass, and modifying an original tracked test makes each task fail. Reference solutions and checkers must never be copied into agent repositories.

`--validate-only` checks configured executables, selected tasks, limits and provenance without a credential or provider request:

```sh
python3 "$HARNESS/runner.py" --root "$BENCH_ROOT" \
  --core-base "$CORE_BASE" --core-candidate "$CORE_CANDIDATE" \
  --pi-prefix "$PI_PREFIX" --phase baseline --validate-only
```

## Credentials and paid runs

Supply `DEEPSEEK_API_KEY` only through the runner's process environment. Never put it in command-line arguments, a benchmark config file, a Docker `--env` argument, an agent home or a committed file. `stdin_entry.py` optionally accepts one secret line from an already-authorized SSH stdin channel and places it in the Linux process environment. It does not source files or know any SSH host/key path. Pipe directly to that process; do not save the stream.

The provider-facing proxy owns the actual credential. Child coding agents receive only a dummy proxy bearer. Each run has an isolated `HOME`, `AGENC_HOME` and Pi directory. The harness automatically authorizes edits only in its newly created task repositories and runs the Core CLI with approvals/sandbox bypass for those benchmark workspaces. This is a measurement setup, not a sandbox safety evaluation.

The default job cap is $10. The maximum accepted cap is $25; use `--spend-cap-usd 25` only when the study owner authorizes that total. Changing the cap does not reset the cumulative ledger. A run is not launched when the account balance is below $10; only `is_available` and `total_balance` are printed. Peak-price reservations bound outstanding calls, including calls made by children. Unknown usage retains a conservative reserved charge. Balance changes on a shared account are not attributed as this job's spend. Do not launch another benchmark orchestrator with a different output root for the same study/provider: the advisory lock coordinates one provider per output root, not all hosts or unrelated jobs.

```sh
# DEEPSEEK_API_KEY is already present in this command's process environment.
python3 "$HARNESS/runner.py" --root "$BENCH_ROOT" \
  --core-base "$CORE_BASE" --core-candidate "$CORE_CANDIDATE" \
  --pi-prefix "$PI_PREFIX" --phase baseline \
  --models deepseek-flash,deepseek-v4-pro --repeats 2 --workers 2

python3 "$HARNESS/runner.py" --root "$BENCH_ROOT" \
  --core-base "$CORE_BASE" --core-candidate "$CORE_CANDIDATE" \
  --pi-prefix "$PI_PREFIX" --phase candidate-example --agents light \
  --models deepseek-flash,deepseek-v4-pro --repeats 2 --workers 2
```

Phases starting with `candidate-` use the candidate checkout for Light; Pi and normal use the baseline checkout. Every changed candidate, prompt or protocol needs a new phase. Existing incomplete attempts are preserved and cannot be overwritten. Completed results require the same prompt, agent revision and configuration identity before reuse. The package intentionally does not import or rewrite old local-runner evidence.

Prices are dated in `pricing.json` and sourced from the [official DeepSeek pricing page](https://api-docs.deepseek.com/quick_start/pricing). They are calculated list-rate estimates using request-start UTC. Recheck them before running a new study. Cached tokens are part of input tokens, not additional tokens: `total = cached input + uncached input + output`.

For historical ledgers that reserve every unknown-usage call at peak Pro prices, `reconcile_budget.py` can create a new cumulative ledger after the original stops changing. It retains the exact legacy worst-case token allowance, validates the captured model, explicit output cap, original reserve and request-time rates against `pricing.json`, then uses those verified model/time prices. It never changes measured cost, reconstructs missing tokens or overwrites the source ledger or task results. The derived records retain `original_budget_charge_usd`; the audit report hashes the source, pricing and affected wire captures. A later runner must append to that complete derived ledger, never an empty ledger. Publish the report and original/derived charge distinction. Run its eight offline checks with `python3 test_reconcile_budget.py`.

For a small optional Luna subset, use `--provider openai --models gpt-6-luna --workers 1 --tasks 01-chunked-strict,04-count-by` and an existing loopback Responses bridge supplied with `--openai-upstream http://127.0.0.1:PORT/v1/responses`. The runner does not start or reconfigure an external OAuth proxy. If no existing bridge is available, skip this subset and report it.

`luna_bridge.py` optionally transports requests from a Linux loopback listener over outbound SSH stdio to a Mac HTTP client using an already-running Mac loopback proxy. Supply `LUNA_PROXY_BEARER` only in the Mac relay process environment, and pass explicit `--ssh-host`, `--ssh-key` and `--remote-script` arguments to `relay`. No host/key/owner-path defaults are included. The real bearer stays on the Mac; request headers never cross the channel. The helper opens no Mac network listener and does not start the OAuth proxy. It permits only GPT-6 Luna Low, at most two concurrent requests and 40 total requests. Each HTTP request runs in an owned local child with a hard absolute deadline (default and maximum 180 seconds), plus a 512 KiB default response-byte budget. Continuous whitespace cannot extend that deadline as it could an idle socket timeout. Only that request's explicit child PID is terminated. Set lower `--request-seconds` or `--response-bytes` limits for a small subset. A limit leaves usage incomplete; it is not a passing run or a zero-cost claim. Closing this client connection does not prove the existing proxy cancelled its own upstream generation; the helper does not alter that proxy.

## Compare and audit

```sh
python3 "$HARNESS/summarize.py" --runs "$BENCH_ROOT/runs" \
  --candidate-phase candidate-example --models deepseek-flash,deepseek-v4-pro \
  --json-out "$BENCH_ROOT/analysis.json" --markdown-out "$BENCH_ROOT/analysis.md" \
  --fail-unproven
python3 "$HARNESS/trace_audit.py" --runs "$BENCH_ROOT/runs" \
  --benchmark-root "$BENCH_ROOT" --completed-only --out "$BENCH_ROOT/trace-review.json"
```

The strict gate requires at least two distinct repeats per task/model/agent. Candidate Light must have no greater mean total token use and no lower pass rate than Pi on every task and in totals. Every task Pi completes must have all Light repeats complete. Each model must also have strictly lower median and nearest-rank p90 wall time across all attempts, including failures. The normal baseline is required; original baseline Light is shown diagnostically. All selected failures remain in denominators and cost totals. A timeout, budget stop or abnormal exit is not a passing task even when artifact checks pass. Missing/incomplete usage and mismatched provider/model/sampling evidence make the comparison insufficient, not a win.

Every captured request is checked for the run's declared model and reasoning/sampling settings, including subagent and fallback calls. System/developer content and Responses instructions are hashed across calls without normalizing their text. Character anatomy is only a prompt-size proxy, not billed token usage. Two repeats support an exploratory comparison on these tasks, not a statistical proof across every workload.

The trace audit reviews tool-call arguments in captured requests and responses, including final and partial streamed calls that never appear in a later request history. It deduplicates repeated calls and emits hashes, tool names and review categories without argument content. It flags potential hidden-checker/reference/sibling paths and ambiguous out-of-workspace references for human review. A flag is not an automatic cheating claim. Obfuscated accesses and indirect script behavior may not be detected. `--completed-only` includes failed result records but skips active directories without a result. Use `--phase baseline` to inspect one exact phase. Later audits can use `--prior-report FILE` to reuse unchanged capture inventories; changing files are flagged for a later stable audit. Run the audit with the same mount paths used during measurement so legitimate workspace paths are recognized.

## Integrity limits and publishing evidence

Original tracked tests must remain byte-identical to the pinned source commit. Feature tests must be new and include at least four passing, non-skipped cases in addition to hidden behavior checks. Task 12 asks for a checklist tool if one exists: Pi may use text; AgenC must successfully use TodoWrite, and Light must discover it first. Both Chat Completions and Responses receipts are supported by the trace checker.

Each agent sees its task prompt and fresh repository. Checkers and reference solutions sit outside that repository. The current process-based harness uses instructions, isolated homes, fresh trees and trace review; it does not enforce an adversarial filesystem boundary around each agent. For stronger isolation, run agents in separate containers with only task files and required executables available. That is a protocol change and should receive fresh benchmark evidence.

Raw request bodies, responses, logs and homes can contain private content. Keep them local, restrict access and scan all generated files for credentials before sharing. Publish only selected aggregate/per-run metrics, per-call usage accounting and a SHA256 inventory of retained raw artifacts after the study has stopped. Include failed/incomplete attempts and all spend in auxiliary accounting. Do not publish request bodies, response text, credentials or owner-specific absolute paths. No final study evidence is included in this package while measurements are still running.
