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
  count as workspace removals in every mode. `workdir` outside the workspace
  still needs `--add-dir`; the adapter passes `add_dirs` (default `/`).

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
