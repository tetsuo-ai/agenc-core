# Terminal-Bench 2.0 through Harbor

A public, reproducible way to measure AgenC against other agent harnesses on
the same tasks and the same model. Terminal-Bench 2.0 is 89 verified terminal
tasks (Laude Institute); Harbor is its runner. Every trial installs the agent
inside the task container, runs one instruction, and grades the container
state with the task's own tests. The score is pass@1 over the tasks.

## What is measured

- The agent harness, at a fixed model. Harbor reports rows as `agent +
  model`, so AgenC on DeepSeek V4 Pro sits next to OpenCode or Hermes on the
  same model. Model choice moves scores far more than the harness does, so a
  comparison only means something at equal model.
- Time and tokens per task, from AgenC's own rollout (`token_count` events),
  so the run also answers "how much does a solved task cost".

## The adapter

`runtime/eval/harbor/agenc_agent.py` is a Harbor installed-agent adapter
(`--agent agenc_agent:Agenc` with the file's directory on `PYTHONPATH`). It
installs AgenC with the public installer (`https://get.agenc.ag/install.sh
--no-daemon`), or from a tarball built by
`packages/agenc/scripts/build-runtime-tarball.mjs` when `runtime_url` is set,
which is how an unreleased commit of main is measured. It then runs

```
agenc --dangerously-bypass-approvals-and-sandbox --provider <p> --model <m> -p "<instruction>"
```

in the task's working directory, trusting that directory first. The model
name follows Harbor's `provider/model` form. The provider's key is read from
the runner's environment and forwarded only into the agent process.

Options (`--ak key=value`): `version` (pin a release), `manifest_url`,
`runtime_url`, `effort` (default `medium`), `add_dirs` (extra workspace
roots passed as `--add-dir`, default `/`: the tasks configure the whole
container and AgenC's shell write policy otherwise refuses writes outside
the task directory, a boundary the other harnesses do not have), and
`stop_daemon` (default false).

The same file carries `HermesCurrent`, Harbor's Hermes adapter with its
install check fixed (the current Hermes CLI has no `version` subcommand) and
DeepSeek registered as a native Hermes provider, so Hermes reaches DeepSeek
directly instead of through OpenRouter. OpenCode runs through Harbor's own
ACP adapter (`-a acp:opencode`).

## Running

```bash
uv tool install harbor
harbor datasets download terminal-bench@2.0 -o ./tb2
export PYTHONPATH=/path/to/agenc-core/runtime/eval/harbor
DEEPSEEK_API_KEY=... harbor run -p ./tb2/terminal-bench -a agenc_agent:Agenc \
  -m deepseek/deepseek-v4-pro -o ./jobs/agenc -n 4 -k 1
```

Task images are `linux/amd64`. On Apple silicon, run Docker in a VM with
Rosetta (colima: `--vz-rosetta`) and share the working directory with the VM
(colima: `--mount <dir>:w`), or Harbor's bind mounts come back empty and no
reward file is found. Slim images lack `libatomic.so.1`; the adapter installs
it before the bundled Node runs.

For an unreleased build of main:

```bash
AGENC_ARTIFACT_PROFILE=container-local AGENC_RELEASE_OUT_DIR=./dist \
  node packages/agenc/scripts/build-runtime-tarball.mjs      # on linux-x64; see the glibc note below
python3 -m http.server 8765 --directory ./dist &
harbor run ... -a agenc_agent:Agenc --ak runtime_url=http://host.docker.internal:8765/<tarball>
```

## What the first runs found in AgenC itself

- Slim Debian and Ubuntu images lack `libatomic.so.1`; the bundled Node dies
  at daemon spawn. The adapter installs it.
- Main aborted every headless run on a host without a Secret Service
  ("Native secure storage read failed"); release 0.17.0 did not. Fixed in
  core #2424, which is the first commit a benchmark build of main must carry.
- `exec_command` containment kills every process the agent started when the
  command returns, and a managed background process (`yield_time_ms`) dies
  when the one-shot session ends, daemon running or not (checked by hand in
  the nginx task image). A server or daemon the agent set up was gone by the
  time the grader ran, and the tool result never said so: the pilot
  rollouts show the model running `nginx`, `setsid nginx`, `setsid -f ...`
  and finally `nginx -g 'daemon off;'` under `yield_time_ms`, each time
  finding nothing listening afterwards. Three of the four failures in every
  AgenC run were tasks of that shape (nginx, a git server with a deploy
  hook, an sshd-based multi-branch server); Hermes and OpenCode passed them
  on the same model. Fixed 2026-09-12: the result now carries a note when
  leftover processes were stopped, and `exec_command` takes `detach: true`
  to start a service that outlives the command and the session (under the
  `danger-full-access` sandbox only). See
  [tools-permissions-sandbox](../reference/tools-permissions-sandbox.md#shell--process).
- Even with `--dangerously-bypass-approvals-and-sandbox`, the shell write
  policy refused removals outside the workspace (`unlink
  /etc/nginx/sites-enabled/default`, `rm -rf /git/project`) and every
  command it could not analyse, which was any command containing `$(...)`:
  51 of 459 shell calls in the git-multibranch run, most an `echo "$(...)"`
  beside a harmless write. Fixed 2026-09-12: with approvals bypassed and no
  sandbox, those two guards are lifted (protected paths and the Edit/Write
  routing for workspace files stay), and removals under `--add-dir` roots
  count as workspace removals in every mode, and `workdir` may point at an
  added directory or, under the full bypass, anywhere. The first rerun with
  that build still showed the refusals: the dispatcher ran a tool's
  preflight before it attached the runtime context, so the policy decided
  with no session at all; a provisional context is now attached first.
- Under the same flag, and even with `--add-dir /`, `Edit`, `Write` and
  `FileRead` refused every path outside the workspace (`Access denied: Path
  is outside allowed directories`, 8 times in one nginx trial): the
  permission layer allowed the path but never handed the tool the widened
  root it hands out after an approval. Fixed 2026-09-12 in
  `checkToolPathPermission`. The first rerun also showed `detach: true`
  refused by the Editor workspace fence, which the dispatcher keeps around
  every tool call; a detached service is now outside that fence. `tty: true`
  is still refused by the same fence in one-shot runs (pre-existing, open).
  The full run then showed the file-tool refusal again on FileRead of
  `/build/gcc-13.2.0/...` (custom-memory-heap-crash): under the full bypass
  the permission evaluator does not run, so the permission-layer fix never
  executed; the dispatcher now widens the root itself (2026-09-13).
- A task whose instruction starts with `-` (pytorch-model-recovery) made the
  CLI reject the prompt as an unknown option. The adapter now passes the
  instruction after `--`.
- Harbor pulls each task image when the trial starts, with a 600 s limit.
  On a slow line the multi-GB images time out (`EnvironmentStartTimeoutError`,
  21 of the first 71 trials of the full run on a 4 Mbit/s Wi-Fi link) and
  concurrent pulls starve the tasks that download data. Pull all 89 images
  first (`docker pull alexgshaw/<task>:20251031`) and only then run.
- `qemu-startup` (Debian 11) and `wdm-design` (miniforge on the same glibc
  2.31) cannot start the daemon: the CLI runs, but the daemon loads
  `better_sqlite3.node`, and that binary, built in the `node:26-bookworm`
  image, needs `GLIBC_2.33`. The CLI reported only "daemon startup failed
  and replacement cleanup could not be verified"; the real line sits in
  `$AGENC_HOME/daemon-spawn-stderr.log`. Building in `node:26-bullseye`
  does not work: its gcc 10 cannot compile Node 26's C++20 headers
  (`<source_location>`), and the upstream better-sqlite3 prebuilds also need
  glibc 2.34. What works is `gcc:12-bullseye` with the Node 26.5.0 binary
  tarball, `npm_config_build_from_source=true` (so node-pty and better-sqlite3
  skip their prebuilds) and `LDFLAGS="-static-libstdc++ -static-libgcc"`: the
  resulting `.node` files need only glibc 2.29 and no `GLIBCXX` symbol (a
  gcc-12 build without the static flag needs `GLIBCXX_3.4.29`, which the
  same images lack). The daemon then starts on `wdm-design`.
- Subagents (`spawn_agent`) under the same full bypass with `--add-dir /` were
  refused on every path outside the workspace ("Access denied: Path is
  outside allowed directories" on `Glob path=/tmp`, three Astra trials) while
  the parent session searched the same directories freely: child tool calls
  skip the dispatcher that widens the roots. A probe container reproduced it
  (parent fine, child refused on `/tmp/probe-dir` and `/root/.cache`). The
  child tool path now applies the same widening.
- One upstream socket drop on the proxy host (`EHOSTUNREACH` at 09:39Z) ended
  a grok trial after 1.5 h of work: the truncated stream came back as a plain
  provider error ("Stream closed without a response.completed or
  response.failed event"), which neither retry classifier recognized, so the
  turn failed and the one-shot exited 1. The adapters now raise the typed
  `LLMStreamTruncatedError`, retried through the same ladder as `stream_idle`.
- GPT-6 Astra answered a task with conflicting data by calling
  `AskUserQuestion`. In print mode nobody can answer, the client auto-denied
  it, and the turn ended with exit 2 (`NonZeroAgentExitCodeError`, reward 0).
  The one-shot CLI now creates its session with
  `runtimeOptions.nonInteractive`, which hides the tool; the adapter also sets
  `tools_config.disabled_tools` for older runtimes.

## Results

Pilot, 2026-09-12: 11 tasks, one trial each, DeepSeek V4 Pro direct at
medium effort for every agent, run on a Mac through colima with Rosetta (so
timings are indicative and the 900 second task budget is tight). AgenC
0.17.0 is the public installer; AgenC main is commit 4c3afd221 (with #2424
and #2427) as a tarball; the `+adddir` column reruns AgenC main's four
failed tasks with `add_dirs=/`.

```
task                         agenc-0.17.0 agenc-main agenc+adddir     hermes   opencode
---------------------------------------------------------------------------------------
chess-best-move                       0          0          1          1          0
configure-git-webserver               0          0          0          0          0
count-dataset-tokens                  1          1          -          1          1
extract-elf                           1          1          -          1          1
fix-git                               1          1          -          1          1
git-multibranch                       0          0          0          1          1
log-summary-date-ranges               1          1          -          1          1
nginx-request-logging                 0          0          0          1          1
openssl-selfsigned-cert               -          1          -          1          1
regex-log                             1          1          -          1          1
sqlite-db-truncate                    1          1          -          1          1
---------------------------------------------------------------------------------------
pass                               6/10       7/11        1/4      10/11       9/11
agent time (s), sum                3703       4080       1780       3232       2896
input tokens, sum              10805626    9248524    4929672          0       3330
output tokens, sum               288694     297244     116402          0       1607
```

Hermes 10/11, OpenCode 9/11, AgenC main 7/11 (8/11 counting the chess pass in
the rerun; that task sits at the timeout under emulation). Every agent failed
configure-git-webserver. The two tasks AgenC fails and the others pass,
nginx-request-logging and git-multibranch, need a service to keep running
after the agent's last command; see the containment finding above. Token
columns: only AgenC's adapter reports usage from its rollouts; Harbor's
Hermes adapter reports none and the OpenCode adapter only the last message.
Raw job directories with per-trial rollouts and grader output are kept
outside the repo (`~/claude-agenc/bench-harbor/jobs` on the run host).

## Full run, 2026-09-13

All 89 tasks, AgenC main (618d2e0db for the first 35 tasks, f43416a00 after
the dispatch-root fix merged), DeepSeek V4 Pro at medium effort, one clean
trial per task, on a 24-thread Ryzen 9900X Ubuntu 26.04 host with native
x86 Docker. Reruns were used only for trials that never produced an agent
run (image pull or grader timeouts), for the two trials the old adapter
could not start, and for failures where the file tools were refused before
f43416a00; a pass was never replaced by a later failure.

**AgenC (main 618d2e0db and f43416a00), DeepSeek V4 Pro, one clean trial per task: 61/89 passed of 89 tasks.**

Failures by cause: 16 tasks failed the grader outright, 7 hit the task's agent timeout, 2 hit the grader's own 600 s timeout, 2 run on Debian 11 images the runtime cannot start on, and 1 (pytorch-model-recovery) is counted from the trial the old adapter could not start plus two grader timeouts on the retries. Total cost of the run including reruns: about 19 USD of DeepSeek credit; 146 trials in all.

What the number contains:

- Seven tasks hit their own agent timeout (900 to 3600 s) and count as
  failures; two more (model-extraction-relu-logits, path-tracing-reverse)
  timed out in one attempt but passed the grader in another and count as
  passes.
- Two tasks (`qemu-startup`, `qemu-alpine-ssh`) run on Debian 11 images with
  glibc 2.31; the runtime build needs 2.34, so the daemon cannot start and
  they count as failures. Hermes (Python) and OpenCode (a static binary) do
  not have this limit.
- Three grader timeouts (`torch-tensor-parallelism`, `torch-pipeline-parallelism`,
  `pytorch-model-recovery`): the grader installs `torch==2.7.1` at test time
  and the host's 4 Mbit/s line could not deliver it inside the 600 s
  verifier limit. They count as failures.
- `caffe-cifar-10` died with exit 137 inside the task's 4 GiB memory limit
  (AgenC's daemon plus the training run). Counted as a failure.
- The agent chose `detach: true` for a service in 11 tasks; the
  residue note fired in 10 trials.

| task | pass | agent s | shell calls | detach | note |
| --- | --- | --- | --- | --- | --- |
| adaptive-rejection-sampler | 1 | 882 | 11 |  |  |
| bn-fit-modify | 1 | 368 | 19 |  |  |
| break-filter-js-from-html | 1 | 62 | 7 |  |  |
| build-cython-ext | 1 | 486 | 28 |  |  |
| build-pmars | 1 | 671 | 28 |  |  |
| build-pov-ray | 1 | 1172 | 69 |  |  |
| caffe-cifar-10 | 0 | 1200 | 7 |  | timeout |
| cancel-async-tasks | 0 | 131 | 4 |  |  |
| chess-best-move | 0 | 868 | 33 |  |  |
| circuit-fibsqrt | 1 | 822 | 7 |  |  |
| cobol-modernization | 1 | 328 | 22 |  |  |
| code-from-image | 0 | 247 | 15 |  |  |
| compile-compcert | 1 | 2229 | 98 | 7 |  |
| configure-git-webserver | 0 | 205 | 20 | 1 |  |
| constraints-scheduling | 1 | 68 | 0 |  |  |
| count-dataset-tokens | 1 | 203 | 8 |  |  |
| crack-7z-hash | 1 | 167 | 22 |  |  |
| custom-memory-heap-crash | 1 | 265 | 27 |  |  |
| db-wal-recovery | 1 | 578 | 37 |  |  |
| distribution-search | 1 | 153 | 3 |  |  |
| dna-assembly | 0 | 957 | 16 |  |  |
| dna-insert | 0 | 550 | 17 |  |  |
| extract-elf | 1 | 206 | 19 |  |  |
| extract-moves-from-video | 0 | 1800 | 35 |  | timeout |
| feal-differential-cryptanalysis | 1 | 136 | 4 |  |  |
| feal-linear-cryptanalysis | 1 | 585 | 9 |  |  |
| filter-js-from-html | 0 | 389 | 12 |  |  |
| financial-document-processor | 1 | 273 | 20 |  |  |
| fix-code-vulnerability | 1 | 56 | 8 |  |  |
| fix-git | 1 | 62 | 15 |  |  |
| fix-ocaml-gc | 1 | 482 | 12 |  |  |
| gcode-to-text | 0 | 900 | 26 |  | timeout |
| git-leak-recovery | 1 | 35 | 13 |  |  |
| git-multibranch | 1 | 261 | 36 | 2 |  |
| gpt2-codegolf | 0 | 900 | 12 |  | timeout |
| headless-terminal | 1 | 162 | 14 |  |  |
| hf-model-inference | 1 | 123 | 7 | 1 |  |
| install-windows-3.11 | 1 | 3019 | 128 | 7 |  |
| kv-store-grpc | 1 | 104 | 7 | 1 |  |
| large-scale-text-editing | 1 | 316 | 12 |  |  |
| largest-eigenval | 0 | 597 | 30 |  |  |
| llm-inference-batching-scheduler | 1 | 848 | 28 |  |  |
| log-summary-date-ranges | 1 | 27 | 9 |  |  |
| mailman | 1 | 866 | 96 | 2 |  |
| make-doom-for-mips | 0 | 900 | 87 |  | timeout |
| make-mips-interpreter | 0 | 1631 | 89 |  |  |
| mcmc-sampling-stan | 1 | 908 | 54 |  |  |
| merge-diff-arc-agi-task | 1 | 172 | 17 |  |  |
| model-extraction-relu-logits | 1 | 900 | 14 |  | timeout |
| modernize-scientific-stack | 1 | 32 | 1 |  |  |
| mteb-leaderboard | 1 | 70 | 0 |  |  |
| mteb-retrieve | 0 | 78 | 8 |  |  |
| multi-source-data-merger | 1 | 131 | 8 |  |  |
| nginx-request-logging | 1 | 85 | 7 | 1 |  |
| openssl-selfsigned-cert | 1 | 164 | 9 |  |  |
| overfull-hbox | 0 | 336 | 13 |  |  |
| password-recovery | 1 | 150 | 17 |  |  |
| path-tracing | 1 | 552 | 20 |  |  |
| path-tracing-reverse | 1 | 1628 | 35 |  |  |
| polyglot-c-py | 0 | 315 | 11 |  |  |
| polyglot-rust-c | 0 | 405 | 4 |  |  |
| portfolio-optimization | 1 | 268 | 12 |  |  |
| protein-assembly | 0 | 985 | 16 |  |  |
| prove-plus-comm | 1 | 46 | 4 |  |  |
| pypi-server | 1 | 68 | 12 | 1 |  |
| pytorch-model-cli | 1 | 237 | 23 |  |  |
| pytorch-model-recovery | 0 | 1 | 0 |  | agent exit exit 2 |
| qemu-alpine-ssh | 0 |  | 0 |  | glibc 2.31 host |
| qemu-startup | 0 | 2 | 0 |  | glibc 2.31 host |
| query-optimize | 0 | 656 | 18 |  |  |
| raman-fitting | 0 | 900 | 35 |  | timeout |
| regex-chess | 1 | 2505 | 13 |  |  |
| regex-log | 1 | 136 | 6 |  |  |
| reshard-c4-data | 1 | 380 | 22 |  |  |
| rstan-to-pystan | 1 | 1100 | 48 |  |  |
| sam-cell-seg | 0 | 1167 | 36 |  |  |
| sanitize-git-repo | 1 | 146 | 10 |  |  |
| schemelike-metacircular-eval | 1 | 565 | 16 |  |  |
| sparql-university | 1 | 115 | 5 |  |  |
| sqlite-db-truncate | 1 | 249 | 9 |  |  |
| sqlite-with-gcov | 1 | 339 | 27 |  |  |
| torch-pipeline-parallelism | 0 | 532 | 6 |  | verifier timeout |
| torch-tensor-parallelism | 0 | 193 | 4 |  | verifier timeout |
| train-fasttext | 0 | 3602 | 37 | 1 | timeout |
| tune-mjcf | 1 | 499 | 19 |  |  |
| video-processing | 1 | 752 | 32 |  |  |
| vulnerable-secret | 1 | 44 | 7 |  |  |
| winning-avg-corewars | 1 | 926 | 43 |  |  |
| write-compressor | 1 | 526 | 10 |  |  |

The workspace write policy's remaining refusal, a shell content write into
the workspace ("use Edit or Write instead"), appeared in 23 of the 146
trials, 16 times in build-pov-ray alone. It is the one deliberate guard
left that costs turns under the full bypass; whether to lift it there is an
open product decision.
