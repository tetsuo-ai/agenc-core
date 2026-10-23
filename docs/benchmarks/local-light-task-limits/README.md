# Local Light model experiments on Spark 1

The combined local Light profile reduced median workload time by 7.1% on Spark 1
and passed all six independent task attempts. Median token usage was inconclusive
(+1.2%). Keep both settings opt-in; these results do not establish a general
token-saving policy for local models.

Every confirmation trial, including failures and outliers, is in
[results.json](results.json). [fixtures.json](fixtures.json) contains the exact
prompts, initial files and independent checks. The fixture SHA-256 is
`b06835119378e56a33f6fff969839ed7e4a1cddbc80ede5f884d82a90d903c46`.

## Results

Values are medians of three repetitions of the two-task workload: add each
repetition's CSV and SQLite measurements, then take the median. Correctness
counts individual task attempts whose supplied and held-out checks all passed.
A fast unfinished attempt stays in the measurements and counts as a failure.

| Client setting | Total tokens, before → after | CLI seconds, before → after | Independent checks, before → after |
| --- | ---: | ---: | ---: |
| Task limits only | 40,497 → 61,574 | 52.040 → 64.656 | 4/6 → 6/6 |
| Patch editor only | 51,793 → 106,820 | 60.377 → 111.513 | 5/6 → 6/6 |
| Both settings | 76,540 → 77,469 | 70.365 → 65.357 | 5/6 → 6/6 |

Task limits alone increased median tokens by 52.0% and time by 24.2%. Patch
editing alone increased tokens by 106.2% and time by 84.7%. The patch-only CSV
outlier used 23 model calls and 156,536 tokens, including stale-patch retries;
it is retained in the raw results. Improved correctness does not make either
standalone setting a token or latency improvement.

The combination improved the required latency objective by 7.1%; the primary
token metric stayed inside the 5% comparison band. All three paired workload
repetitions finished faster and used fewer model calls. Across all six attempts,
total tokens fell from 230,937 to 189,100 (18.1%), total CLI time from 221.897 to
174.772 seconds (21.2%), and model calls from 52 to 45. These totals are descriptive;
they do not replace the predeclared median comparison. The token result is noisy,
and the SQLite task remained more expensive by its per-task token median.

The measured combination is:

```sh
AGENC_LIGHT_APPLY_PATCH=1 AGENC_LIGHT_TASK_LIMITS=1 agenc --light
```

The new editor switch applies only to local providers (`openai-compatible`,
`lmstudio`, `ollama`) in Light mode. No model-family inference or default editor
policy changes. `Edit` and `Write` remain discoverable, and the existing patch
execution safeguards still apply.

## Workload and controls

The tasks are a CSV order-summary repair (four supplied and ten held-out tests)
and a persistent SQLite CLI (three supplied and eight held-out tests). Each
trial starts in a fresh workspace with the same files, prompt, permissions and
deadline. Supplied tests must remain unchanged. The model cannot see the
held-out checks in its workspace.

Each experiment runs three before/after repetitions per task, with order
before/after, after/before, before/after. Experiments have their own fresh
controls; results from different experiments are not pooled. The baseline is
AgenC 0.19.13 at `2a25d23c334fc289084d234aeb2070ffcdcdf790`, rather than the
operator's installed 0.19.12. Measured build hashes and candidate revisions are
recorded in the JSON. JavaScript builds used unchanged native dependencies and
sandbox helpers from the installed Linux ARM64 runtime. Build VERSION files
predate the implementation commits; archive hashes identify the measured bytes.

For each experiment the same client environment is supplied to both versions.
Baseline versions ignore the unsupported client override; candidates capture
it in the session. Daemons start without either override, so daemon process
inheritance cannot mask broken forwarding. A loopback recorder verifies the
model, successful HTTP responses and finishing guidance on every model call.
Editor experiments also verify the first advertised tool catalog. The proxy
forwards request bodies unchanged.

The client runs on Spark 1 (`spark-db08`, Linux ARM64), Node 26.12.1. TensorFold
serves the existing DeepSeek EXL3 deployment at `http://127.0.0.1:8888/v1`:
1,048,576-token context, thinking disabled, temperature 1, top-p 1, top-k 20,
parallel 4, engine output limit 32,768. AgenC requests at most 8,192 output tokens.
The deployment may span both Sparks; this is a Spark 1 client experiment, not a
single-device inference throughput benchmark. The model server and its cache
settings were not changed or reset. No paid inference API was used.

AgenC runs with `--permission-mode acceptEdits`, bubblewrap and fully enforced
Landlock. Post-run checks use a separate bubblewrap process with read-only code,
a private temporary directory, no network and only Python's system libraries.
Verification requires all expected tests to execute and pass, with no skips.
All 24 implementations from the first two experiments were rechecked with this
completed-suite verification; their original correctness outcomes matched. The
combined experiment enforced completed-suite receipts during all 12 trials.
AgenC exit codes and denied permissions are recorded separately: a cleanup
command denied after correct code was written can yield exit 2. Neither that
exit nor exit 0 substitutes for the independent checks.

Token counts include input and output, including cached input. CLI wall time
includes startup, inference and tool execution; post-run verification is
excluded. The intended improvement threshold is more than 5%, with no greater
than 5% wall-time regression and all candidate correctness checks passing.
Three repetitions at temperature 1 provide limited evidence and substantial
variation. These small tasks do not establish behavior near a million-token
context limit or across other local models.

Six exploratory baseline trials preceded the task-limits confirmation. Earlier
setup trials inherited the flag in the daemon, and one trial was interrupted;
they were excluded before confirmation and were not substituted into its
control group. The patch-only setup initially failed a private-directory
permission check before any model request. No completed confirmation trial was
dropped for a bad score. Reproducer hardening changed verification, environment
cleaning and failure handling, without changing the measured prompts or CLI
wall times; the earlier implementations were independently reverified.

## Reproduce

Use Linux with Python 3, bubblewrap and Node 26.x. Build the baseline and
candidate in separate checkouts with their matching SDK builds:

```sh
npm ci
npm run build --workspace=@tetsuo-ai/agenc-sdk
npm run build
```

The benchmark needs its own private daemon homes and output directory. Pass
absolute runtime and Node paths. If AppArmor requires AgenC's existing
per-command profile, add `--apparmor-profile agenc-native-userns`.

```sh
python3 docs/benchmarks/local-light-task-limits/evaluate.py \
  --experiment apply-patch \
  --root /absolute/path/to/new-output \
  --home-root /absolute/path/to/private-homes \
  --fixtures docs/benchmarks/local-light-task-limits/fixtures.json \
  --before /absolute/path/to/baseline/runtime/bin/agenc \
  --after /absolute/path/to/candidate/runtime/bin/agenc \
  --node /absolute/path/to/node26 \
  --base-url http://127.0.0.1:8888/v1 \
  --model DeepSeek-v4.1-Flash-EXL3 \
  --repeats 3
```

`--experiment task-limits` sets only `AGENC_LIGHT_TASK_LIMITS=1`;
`apply-patch` sets only `AGENC_LIGHT_APPLY_PATCH=1`; `combined` sets both.
The other setting is explicitly disabled. Parent directories of private homes
must satisfy AgenC's ownership and permission checks. Only use an empty,
benchmark-specific home root; the runner creates isolated configurations and
starts/stops daemons there. It does not alter the normal installation or model
server. A client timeout aborts the comparison and stops its isolated daemons,
so a late turn cannot contaminate a later trial. Missing token usage stays
unavailable.

Run verifier regressions without a model server:

```sh
python3 -B -m unittest discover \
  -s docs/benchmarks/local-light-task-limits -p test_evaluate.py -v
```

## Code validation

The new editor/session tests include regressions that failed before the source
change. The focused suite passed 239 tests across eight files, covering editor
selection, prompt agreement, daemon snapshots, local MCP discovery, wire
filtering, existing patch execution/read-before-write checks and environment
documentation. Typechecking (including test support), generated SDK parity,
SDK build and runtime build passed. The three Python verifier regressions pass.

`npm run test:fast` was run and stops at the startup cron-warning assertion in
`runtime/tests/bin/bootstrap.test.ts` on macOS. The same five parameterized cases
fail on an unchanged `2a25d23` checkout: the platform cannot traverse directory
file-descriptor aliases, and startup suppresses the unsupported-descriptor
warning when there is no durable cron record. This PR does not change those
paths. The full fast gate is not reported as passing.
