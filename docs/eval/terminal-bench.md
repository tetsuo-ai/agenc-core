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
  node packages/agenc/scripts/build-runtime-tarball.mjs      # on linux-x64
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
  command returns, and a managed background process (`run_in_background`)
  dies when the one-shot session ends, daemon running or not (checked by
  hand in the nginx task image). A server or daemon the agent set up is gone
  by the time the grader runs. Three of the four failures in every AgenC
  run were tasks of that shape (nginx, a git server with a deploy hook, an
  sshd-based multi-branch server); Hermes and OpenCode passed them on the
  same model. Other harnesses leave such processes alive. This is a product
  decision still open: an opt-in way to leave a service running.
- Even with `--dangerously-bypass-approvals-and-sandbox`, shell commands
  that write or delete under `/etc`, `/var/www` or `/git` are refused by the
  workspace write policy, and `workdir: /tmp` is refused as outside the
  workspace. `--add-dir /` lifts that for the benchmark; see `add_dirs`.

## Results

RESULTS_PLACEHOLDER
