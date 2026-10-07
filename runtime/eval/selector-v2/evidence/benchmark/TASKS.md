# Frozen router benchmark

Version: `router-bench-v1-42`. 42 tasks: 28 calibration, 14 holdout.

The source job has **12 total tasks, including 6 held-out**, not 12 plus 6. All 12 are preserved verbatim in prompt, expected answer and original split. The six source holdouts have already been evaluated by that job and are explicitly reused; the 8 newly authored holdouts provide the fresh holdout stratum. The extension adds six tasks each for tested Python coding, extraction, reasoning, local-file tool use and long context. No holdout is used to tune selector profiles, prompts, candidate identity, routing labels or output budgets.

Task kind, complexity and limits are author declarations frozen before model calls. Calibration is reported separately even if no tuning occurs. Code tasks use 4–5 independent test cases; all must pass. The long-context tasks contain 240 archive records (roughly 50,000 characters each), not a claim to fill every candidate context window.

Every arm gets the identical direct prompt and system prompt. Direct tool-use tasks contain the complete file contents; they measure choice quality for the workload, not actual tool execution. End-to-end runs instead materialize `files` in the isolated workspace and give the parent `agentPrompt`; the parent must spawn a child without provider/model overrides, and that child must read the files. Final answer correctness and actual spawn/read trace must be reported independently. Only six tasks have required local-file tool actions.

## Grading and isolation

`python3 bench_tasks.py grade TASK_ID` reads the raw final-answer text from stdin and prints one JSON verdict. The Python API is `grade(task, response_text)`. Exact JSON graders reject extra keys, markdown and altered array order. Object key order does not matter; numerically equal JSON numbers are equivalent (e.g. `1` equals `1.0`), with no floating tolerance. JSON boolean and integer are distinct. Nonfinite numbers are rejected. All correctness criteria are available before requests.

Generated code is never passed to `eval`, `exec`, `compile`, Node VM, a shell or an external interpreter. `SafePython` interprets an explicitly listed AST subset with fixed builtins and methods, no imports/attributes/reflection/I/O, bounded code/AST/container sizes, and a 100,000-operation limit. Each function gets a deep copy of its test input. Unsupported syntax fails rather than escaping to host Python. This measures a constrained Python language, not unrestricted coding ability. `referenceAnswer` exists only for grader self-tests and must never be included in provider requests or routing calibration.

## Freeze and self-check

`python3 bench_tasks.py verify` validates SHA-256 of tasks, grader and this specification. `python3 bench_tasks.py self-test` checks all reference answers, rejects invalid answers, exercises forbidden code and independently recomputes arithmetic/path/game oracles. `freeze.json` records UTC timestamp, source hash and artifact hashes. Once calls begin, these four files must not change; fixes require a separately versioned suite and invalidation/re-run of affected results.

## Task inventory

| ID | Split | Kind | Difficulty | Grader | Max output tokens |
|---|---|---|---|---|---:|
| cal-simple-extraction | calibration | extraction | simple | exact-json | 4096 |
| cal-simple-coding | calibration | coding | simple | exact-json | 4096 |
| cal-simple-reasoning | calibration | reasoning | simple | exact-json | 4096 |
| cal-hard-extraction | calibration | extraction | hard | exact-json | 4096 |
| cal-hard-coding | calibration | coding | hard | exact-json | 4096 |
| cal-hard-reasoning | calibration | reasoning | hard | exact-json | 4096 |
| hold-simple-extraction | holdout | extraction | simple | exact-json | 4096 |
| hold-simple-coding | holdout | coding | simple | exact-json | 4096 |
| hold-simple-reasoning | holdout | reasoning | simple | exact-json | 4096 |
| hold-hard-extraction | holdout | extraction | hard | exact-json | 4096 |
| hold-hard-coding | holdout | coding | hard | exact-json | 4096 |
| hold-hard-reasoning | holdout | reasoning | hard | exact-json | 4096 |
| cal-code-stable-unique | calibration | coding | simple | restricted-python-tests | 4096 |
| cal-code-interval-union | calibration | coding | moderate | restricted-python-tests | 4096 |
| cal-code-shortest-path | calibration | coding | hard | restricted-python-tests | 4096 |
| cal-code-version-merge | calibration | coding | moderate | restricted-python-tests | 4096 |
| hold-code-window-max | holdout | coding | moderate | restricted-python-tests | 4096 |
| hold-code-topological-order | holdout | coding | hard | restricted-python-tests | 4096 |
| cal-extract-csv | calibration | extraction | simple | exact-json | 4096 |
| cal-extract-units | calibration | extraction | moderate | exact-json | 4096 |
| cal-extract-event-sourcing | calibration | extraction | hard | exact-json | 4096 |
| cal-extract-precedence | calibration | extraction | moderate | exact-json | 4096 |
| hold-extract-timezones | holdout | extraction | moderate | exact-json | 4096 |
| hold-extract-ledger | holdout | extraction | hard | exact-json | 4096 |
| cal-reason-inclusion | calibration | reasoning | moderate | exact-json | 4096 |
| cal-reason-bayes | calibration | reasoning | moderate | exact-json | 4096 |
| cal-reason-maxflow | calibration | reasoning | hard | exact-json | 4096 |
| cal-reason-logic | calibration | reasoning | simple | exact-json | 4096 |
| hold-reason-countpaths | holdout | reasoning | hard | exact-json | 4096 |
| hold-reason-game | holdout | reasoning | moderate | exact-json | 4096 |
| cal-tool-invoice-join | calibration | tool_use | moderate | exact-json | 4096 |
| cal-tool-config-trace | calibration | tool_use | simple | exact-json | 4096 |
| cal-tool-log-correlation | calibration | tool_use | hard | exact-json | 4096 |
| cal-tool-dependency-files | calibration | tool_use | moderate | exact-json | 4096 |
| hold-tool-artifact-manifest | holdout | tool_use | moderate | exact-json | 4096 |
| cal-tool-repair-audit | calibration | tool_use | hard | exact-json | 4096 |
| cal-long-revision | calibration | long_context | hard | exact-json | 4096 |
| cal-long-sum | calibration | long_context | moderate | exact-json | 4096 |
| cal-long-crossref | calibration | long_context | moderate | exact-json | 4096 |
| cal-long-exceptions | calibration | long_context | hard | exact-json | 4096 |
| cal-long-interleave | calibration | long_context | moderate | exact-json | 4096 |
| hold-long-precedence | holdout | long_context | hard | exact-json | 4096 |
