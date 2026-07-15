# Local required gates and GitHub App attestation

Decision record: 2026-07-15

- Protected check: `agenc-local-required-v1`
- Compute boundary: a dedicated local Linux gate host
- GitHub boundary: record and enforce an authenticated exact-SHA result
- Explicit non-goal: GitHub Actions never runs, proxies, or repeats the test
  suite

All required quality gates execute locally. A repository-scoped GitHub App
publishes one Check Run only after the local supervisor has tested a fresh
exact-SHA checkout, removed every candidate process and container, reread the
remote ref, and removed the candidate workspace.

```text
GitHub PR/main ref ──read──> root-installed dispatcher (global lock)
                                  |
                         fresh exact-SHA checkout
                                  |
                    root-owned, read-only candidate source
                                  |
                credential-free candidate worker UID
                                  |
                      npm ci + nine local gates
                         |                |
                  host-only gates    dedicated rootless
                                      Docker UID/socket
                                  |
                 source/ref/process/container cleanup
                                  |
                   random transient publisher unit
                     (App credential mounted here only)
                                  |
                                  └──> exact-SHA GitHub Check Run
```

Candidate code never receives the App private key, JWT, installation token, or
publisher environment. The publisher never accepts a SHA or result from its
command line. Its only selection is `pr-<number>` or the fixed `main` subject,
plus an unpredictable handoff ID created after successful cleanup.

## Required gate contract

The repository command is:

```bash
npm run check:required-gates
```

It requires Linux, Node.js 25.9.0, npm 11.17.0, a clean checkout, and an exact
lowercase 40-character commit. The authoritative deployment runs each gate in
its own transient systemd cgroup.

| Order | Gate | Bound | Candidate write access |
| ---: | --- | ---: | --- |
| 1 | SDK build (includes strict TypeScript compilation) | 5 min | SDK `dist` |
| 2 | Launcher package tests | 5 min | private state only |
| 3 | Local-gate policy tests | 5 min | private state only |
| 4 | Agent-surface checker tests | 5 min | Vite temp only |
| 5 | Hermetic runtime typecheck and stable Vitest suite | 20 min | private state and Vite temp |
| 6 | Agent-surface structural contract | 5 min | private state only |
| 7 | Runtime build and declarations | 10 min | runtime `dist` |
| 8 | Deterministic SPDX SBOM check | 5 min | private state only |
| 9 | PTY/TUI built-runtime startup smoke | 10 min | private state only |

The stable suite already runs the agent-surface Vitest files, so gate 6 uses
`--no-run-commands`; it validates the versioned surface ledger without running
the same tests twice. TUI startup always runs. There is no path filter that can
miss a transitive daemon, launcher, generated-code, or build change.

There are no duplicate compiler passes: the SDK build is its typecheck, and the
hermetic stable-suite container performs the authoritative runtime `tsc
--noEmit` immediately before Vitest.

The SDK output is frozen root-owned immediately after its build. The final
runtime output is likewise frozen after the runtime build. Every later gate
re-hashes frozen artifacts. Per-gate home, AgenC state, npm cache, Docker
configuration, XDG, and temporary roots are private and removed after cgroup
cleanup.

The TUI smoke's trusted parent never imports candidate output. A
permission-restricted child must return a fresh ECDSA proof after the expected
exports return; top-level `process.exit(0)`, a forged IPC marker, missing
exports, or artifact mutation fails. Each real PTY must paint, survive terminal
replies, and remain alive until the supervisor requests termination.

Inspect the policy without running gates:

```bash
node scripts/run-required-gates.mjs --list-json
node scripts/run-required-gates.mjs --contract-json
```

The contract digest covers the ordered inventory, exact toolchain, lockfile,
release verifiers, App/ruleset policy, systemd sandbox builders, hermetic
boundary, TUI supervisor, and their policy tests. The root-installed supervisor
compares a candidate digest with the reviewed root-owned approval before
`npm ci`. A PR cannot approve its own gate-policy change.

## Worker and publisher trust boundaries

The trusted repository mirror is installed root-owned beneath
`/opt/agenc-local-gatekeeper/repo`. systemd must never execute the dispatcher,
runner, TUI supervisor, or publisher from a candidate checkout.

For a PR, the dispatcher:

1. Reads an open, non-draft, same-repository PR targeting `main`. Fork PRs are
   deliberately ineligible for this privileged path.
2. Fetches the canonical remote's current `main` and exact PR head into a new
   disposable checkout, verifies both SHAs, and requires current `main` to be
   an ancestor of the head.
3. Rejects symlink, gitlink, staged-index, unsafe-path, special-file, and
   tracked-scratch collisions before candidate execution.
4. Makes tracked source root-owned and read-only. Only reviewed scratch paths
   are candidate-owned.
5. Validates that every remote lockfile entry is a SHA-512-pinned HTTPS
   artifact from `registry.npmjs.org`. Dependency acquisition is the sole
   network-enabled worker phase and retains direct registry access: it runs
   `npm ci --ignore-scripts --no-audit --no-fund` without credentials or
   lifecycle scripts. A subsequent network-isolated unit rebuilds only the
   fixed native allowlist: `better-sqlite3`, `esbuild`, and `node-pty`. It
   freezes dependency trees root-owned before any candidate code executes.
6. Runs the entire candidate job on a dispatcher-bound, PID 1-managed tmpfs
   capped at 16 GiB and 1,000,000 inodes, and runs every gate in a separately
   bounded transient unit. Each unit also receives a 512 MiB/65,536-inode
   private `/tmp` and a 128 MiB/16,384-inode private `/var/tmp`. Host gates use
   the candidate worker identity. Every candidate unit must resolve the configured
   NSS UID/GID exactly and have no supplementary group except its primary GID;
   the persistent `workerHome` is hidden. Network-isolated units receive an
   empty read-only `/run`. Only the fixed hermetic boundary uses the different
   Docker identity and has the exact rootless Unix socket rebound read-only
   into that otherwise empty `/run`.
7. Stops stale transient gate units and proves their cgroups empty before
   deleting any workspace. It also requires the source to remain clean at the
   original SHA and all frozen artifacts and policy hashes to remain unchanged.
   If a crash left containers in the dedicated Docker daemon, the dispatcher
   forcibly removes them, proves the daemon has zero containers, and then fails
   the dispatch as infrastructure recovery. A clean rerun is required; that
   recovery run cannot attest the candidate.
8. Closes and validates the job-local log, including its 128 MiB ceiling,
   before copying it out of the bounded tmpfs; rereads the remote subject;
   unmounts and removes the candidate workspace; and retains at most 1 GiB, 32
   logs, or 30 days of private root-owned logs. A validation, copy, retention,
   unmount, or cleanup failure creates no ready handoff.
9. Creates a root-owned canonical handoff with a random job ID. While the
   dispatcher's global lock remains held, it starts a random transient
   publisher unit bound to that dispatcher.
10. The publisher validates the subject and job ID and rereads the remote ref
    before systemd exposes the encrypted App key. It mints a repository-scoped
    token, exhaustively paginates App-filtered Check Suites and each suite's
    named runs, creates or updates one App-owned check, and repeats that full
    inventory before reporting success. It therefore does not inherit the
    Git-reference Check Runs endpoint's 1,000-suite truncation.

The merged-`main` path repeats the entire process against the exact current
`refs/heads/main` SHA. This is required because a squash merge creates a commit
that differs from the PR head.

Failure classification is fail-closed:

- a completed candidate gate failure publishes `failure`;
- a moved ref, timeout, setup error, cleanup error, Docker residue, credential
  error, or API/readback error cannot publish success;
- a missing result remains blocking;
- two App-owned checks for the same name and SHA are rejected; and
- a foreign same-name check never satisfies App-bound verification.

## GitHub App

Register a private App from
[`packaging/github/agenc-local-gate-app-manifest.json`](../packaging/github/agenc-local-gate-app-manifest.json)
and install it only on `tetsuo-ai/agenc-core`.

The installed App needs:

- `checks:write`, to create and update its Check Run; and
- `statuses:write`, because GitHub requires that installed permission when an
  App is selected as the expected source of a required status check.

It subscribes to no events and receives no contents-write, administration,
Actions, secrets, or deployment permission. Every publisher installation token
is narrowed further to this repository and `checks:write` only. The publisher
cannot write commit statuses and never emits one.

Record the App's numeric App ID, client ID, and repository installation ID as
`githubAppId`, `githubClientId`, and `githubInstallationId` in the root-owned
nonsecret configuration. The client ID is the JWT `iss`, as recommended by
GitHub. The numeric App ID remains a separate identity: it is the
`integration_id` bound into the ruleset and the `app.id` required on every
Check Run readback. Do not substitute the installation ID for either value.

The private key must not enter Git, shell history, an environment variable, an
AI session, the candidate account, or a candidate workspace. An operator should
encrypt it directly into systemd's credential store and then securely remove
the plaintext input:

```bash
sudo systemd-creds encrypt \
  --name=github-app-private-key \
  app-key.pem \
  /etc/credstore.encrypted/agenc-local-gatekeeper-app-key
```

The static dispatcher has no credential directive. Only the random transient
publisher receives
`LoadCredentialEncrypted=github-app-private-key:...`, after candidate cleanup.
Use overlapping App keys for rotation: install the new encrypted key, verify a
genuine check and readback, then revoke the old key.

## Dedicated Linux host

Use a dedicated cgroup-v2 Linux host. The two sibling resource domains can be
active together, so the host must have at least 48 GiB RAM, 16 available CPUs,
16,384 PIDs at the root cgroup, 64 GiB free system storage, and a separate
16–32 GiB Docker data filesystem. These are admission requirements, not sizing
suggestions. The gate rejects smaller host/cgroup capacity before candidate
work starts.

Install root-owned Git, systemd 255, `systemd-run`, `systemd-creds`, util-linux
`setpriv`, Docker Engine rootless extras/CLI, `cc`, `c++`, `make`, and Python 3. Install Node
25.9.0 and npm 11.17.0 at `/opt/agenc-local-gatekeeper/node`; the same immutable
prefix must contain `include/node/node.h`. The gate accepts only the fixed
compiler/interpreter paths `/usr/bin/cc`, `/usr/bin/c++`, `/usr/bin/make`, and
`/usr/bin/python3`.

Create two distinct system accounts. The numeric examples below are part of the
example config; choose unused IDs once and keep them stable:

```bash
sudo groupadd --system --gid 992 agenc-gate-worker
sudo useradd --system --uid 992 --gid 992 \
  --home-dir /var/lib/agenc-gate-worker --shell /usr/sbin/nologin \
  agenc-gate-worker
sudo groupadd --system --gid 993 agenc-gate-docker
sudo useradd --system --uid 993 --gid 993 \
  --home-dir /var/lib/agenc-gate-docker-home --shell /usr/sbin/nologin \
  agenc-gate-docker
sudo install -d -o 992 -g 992 -m 0700 /var/lib/agenc-gate-worker
sudo install -d -o 993 -g 993 -m 0700 /var/lib/agenc-gate-docker-home
id -u agenc-gate-worker; id -g agenc-gate-worker; id -G agenc-gate-worker
id -u agenc-gate-docker; id -g agenc-gate-docker; id -G agenc-gate-docker
```

Each `id -G` must print only its primary GID. Never add either identity to
`docker`, `sudo`, or another supplementary group. The candidate worker and
Docker account must not share a UID or GID.

### Dedicated Docker filesystem and daemon

Provision a new 24 GiB logical volume or encrypted mapping for this daemon.
Formatting storage is destructive, so the operator must independently verify
the selected empty device; this guide deliberately does not automate `mkfs`.
Format it as ext4 or XFS with no more than 10 million inodes, mount it at
`/var/lib/agenc-gate-docker` with `rw,nosuid,nodev` (and without `noexec`), and
make that mount private. Its `/proc/self/mountinfo` source must be the exact
`/dev/mapper/...` path placed in `dockerDataDevice`; it must not be the root
filesystem or a bind/subvolume mount.

```bash
sudo install -d -o 993 -g 993 -m 0700 /var/lib/agenc-gate-docker
# Add the reviewed /dev/mapper path to /etc/fstab, then:
sudo mount /var/lib/agenc-gate-docker
sudo mount --make-private /var/lib/agenc-gate-docker
sudo chown 993:993 /var/lib/agenc-gate-docker
sudo chmod 0700 /var/lib/agenc-gate-docker
findmnt -no SOURCE,FSTYPE,OPTIONS,PROPAGATION /var/lib/agenc-gate-docker
df -B1 --output=size,avail /var/lib/agenc-gate-docker
df -i --output=itotal,iavail /var/lib/agenc-gate-docker
```

At least 8 GiB and 100,000 inodes must remain free. Install the reviewed
rootless Docker user unit and both resource/socket drop-ins before starting its
user manager:

```bash
sudo install -d -o root -g root -m 0755 \
  /etc/systemd/user/docker.service.d \
  /etc/systemd/system/user-993.slice.d
sudo install -o root -g root -m 0644 \
  packaging/systemd/agenc-local-gate-docker.service \
  /etc/systemd/user/docker.service
sudo install -o root -g root -m 0644 \
  packaging/systemd/agenc-local-gate-docker.service.conf \
  /etc/systemd/user/docker.service.d/50-agenc-local-gate.conf
sudo install -o root -g root -m 0644 \
  packaging/systemd/agenc-local-gate-docker-user.slice.conf \
  /etc/systemd/system/user-993.slice.d/50-agenc-local-gate.conf
sudo systemctl daemon-reload
sudo loginctl enable-linger agenc-gate-docker
sudo systemctl start user@993.service
sudo systemctl --user --machine=993@.host daemon-reload
sudo systemctl --user --machine=993@.host enable --now docker.service
```

For an existing Docker user manager, stop `docker.service`, terminate that
dedicated user session, and start it again only after installing/reloading the
slice policy. Do not weaken the `0600` socket mode to make a check pass.

```bash
sudo systemctl --user --machine=993@.host show docker.service \
  -p FragmentPath -p DropInPaths -p NeedDaemonReload -p ControlGroup -p MainPID
sudo stat -Lc '%u:%g %a %F' /run/user/993/docker.sock
```

The socket result must be `993:993 600 socket`. Provision the one approved
image using the pinned reference from the installed contract, then return the
dedicated daemon to its exact baseline: one image ID, no containers/volumes/
build cache/plugins, Swarm inactive, and only `bridge`, `host`, and `none`
networks.

```bash
node=/opt/agenc-local-gatekeeper/node/bin/node
repo=/opt/agenc-local-gatekeeper/repo
image="$($node --input-type=module -e \
  "import {REQUIRED_DOCKER_IMAGE as i} from '$repo/scripts/required-gate-contract.mjs'; console.log(i)")"
docker=(sudo -u agenc-gate-docker env \
  HOME=/var/lib/agenc-gate-docker-home XDG_RUNTIME_DIR=/run/user/993 \
  DOCKER_CONFIG=/nonexistent /usr/bin/docker \
  --host unix:///run/user/993/docker.sock)
"${docker[@]}" pull "$image"
"${docker[@]}" image tag "$image" node:25.9.0-bookworm
"${docker[@]}" image inspect "$image"
"${docker[@]}" system df --format '{{json .}}'
"${docker[@]}" network ls --no-trunc --format '{{json .}}'
"${docker[@]}" plugin ls --no-trunc --format '{{json .}}'
"${docker[@]}" info --format '{{json .Swarm}}'
```

Do not point the gate at a developer's daemon. The supervisor runs a disposable
read-only, no-network, no-capability container canary and proves its exact CPU,
memory, swap, and PID cgroup below `user-993.slice`; it then removes the canary
and requires a second stable pristine baseline. Any cleanup forces the current
attestation attempt to fail with `DOCKER_RECOVERED`, so only a later clean run
can publish.

### Trusted mirror, configuration, and static units

Install the reviewed commit and toolchain root-owned beneath
`/opt/agenc-local-gatekeeper`; no file there may be writable by the candidate or
Docker account. Install all static units and configuration—not only the
dispatcher:

```bash
sudo install -d -o root -g root -m 0755 /etc/agenc-local-gatekeeper
sudo install -o root -g root -m 0600 \
  packaging/systemd/agenc-local-gatekeeper.config.example.json \
  /etc/agenc-local-gatekeeper/config.json
sudo install -o root -g root -m 0644 \
  packaging/systemd/system-agencgate.slice \
  /etc/systemd/system/system-agencgate.slice
for unit in \
  agenc-local-gate-dispatcher@.service \
  agenc-local-gate-publish@.service \
  agenc-local-gate-context-seed@.service; do
  sudo install -o root -g root -m 0644 "packaging/systemd/$unit" \
    "/etc/systemd/system/$unit"
done
sudo systemctl daemon-reload
sudo systemd-analyze verify \
  /etc/systemd/system/system-agencgate.slice \
  /etc/systemd/system/agenc-local-gate-dispatcher@.service \
  /etc/systemd/system/agenc-local-gate-publish@.service \
  /etc/systemd/system/agenc-local-gate-context-seed@.service \
  /etc/systemd/user/docker.service
```

Replace every config example value, including the exact Docker mount source.
Obtain `approvedContractSha256` only from the independently reviewed commit
already installed in the trusted mirror:

```bash
/opt/agenc-local-gatekeeper/node/bin/node \
  /opt/agenc-local-gatekeeper/repo/scripts/run-required-gates.mjs \
  --contract-json
```

The gate byte-compares every installed unit/drop-in with that mirror. It also
requires PID 1 and the Docker user manager to report the exact reviewed
`FragmentPath`/`DropInPaths`, `NeedDaemonReload=no`, and live cgroup placement.
An instance-specific or user-home Docker override is rejected.

Run a PR gate using only its number-bearing subject:

```bash
sudo systemctl start agenc-local-gate-dispatcher@pr-1505.service
sudo journalctl -u agenc-local-gate-dispatcher@pr-1505.service
```

If all nine gates and cleanup succeeded but GitHub publication/readback failed,
retry only the still-fresh six-hour handoff—do not rerun `npm ci` or the tests:

```bash
sudo systemctl start agenc-local-gate-publish@pr-1505.service
sudo journalctl -u agenc-local-gate-publish@pr-1505.service
```

The retry accepts no SHA, result, or job ID from the operator. It revalidates
the root-approved handoff and current remote ref, then uses the same random
credentialed publisher. Expired handoffs are pruned. After squash merge, the PR
receipt cannot authorize the new commit; attest `main` independently:

```bash
sudo systemctl start agenc-local-gate-dispatcher@main.service
sudo journalctl -u agenc-local-gate-dispatcher@main.service
```

`systemd-analyze security` is useful diagnostics, not proof. Before enabling
the ruleset, perform a supervised activation canary on a disposable PR. Observe
the private 16 GiB/1,000,000-inode job tmpfs and the parent-bound worker units,
then interrupt a gate and exercise a deliberate gate failure, timeout,
retained-container recovery, wrong handoff ID, and missing credential. In every
case, prove the job mount is gone, no candidate/transient process or container
survives, and no success was published. Archive the unit properties, mountinfo,
cgroup records, logs, and exact App readback as deployment evidence.

## Exact App-bound `main` ruleset

[`scripts/local-gate-ruleset.mjs`](../scripts/local-gate-ruleset.mjs) is the
versioned ruleset policy. It renders the exact GitHub REST payload and verifies
the API readback. The required rule has:

- target `branch`, only `refs/heads/main`;
- `bypass_actors: []`;
- context `agenc-local-required-v1`;
- `integration_id` equal to the Check Run's numeric `app.id` (not the
  installation ID);
- `strict_required_status_checks_policy: true`; and
- `do_not_enforce_on_create: false`.

Bootstrap it in this order:

1. Register/install the App with the two permissions above.
2. Run a genuine successful local gate so the App has submitted the named
   check within GitHub's preceding seven-day eligibility window.
3. GitHub requires the App to be associated with a pre-existing required
   context. Render a disabled, temporarily any-source bootstrap ruleset and
   create it using a separate operator credential with repository
   Administration write. The renderer refuses to activate an any-source rule:

   ```bash
   node scripts/local-gate-ruleset.mjs \
     --render --app-id "$APP_ID" --enforcement disabled --source any \
     > /tmp/agenc-main-local-required.json
   gh api --method POST repos/tetsuo-ai/agenc-core/rulesets \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     --input /tmp/agenc-main-local-required.json
   ```

4. Read the assigned ruleset ID back and verify the disabled bootstrap:

   ```bash
   gh api "repos/tetsuo-ai/agenc-core/rulesets/$RULESET_ID" \
     -H "X-GitHub-Api-Version: 2026-03-10" |
     node scripts/local-gate-ruleset.mjs \
       --verify --app-id "$APP_ID" --enforcement disabled --source any
   ```

5. Render a disabled `--source app` payload, update the same ruleset with
   `PUT`, and verify the readback with `--source app`:

   ```bash
   node scripts/local-gate-ruleset.mjs \
     --render --app-id "$APP_ID" --enforcement disabled --source app \
     > /tmp/agenc-main-local-required.json
   gh api --method PUT \
     "repos/tetsuo-ai/agenc-core/rulesets/$RULESET_ID" \
     -H "X-GitHub-Api-Version: 2026-03-10" \
     --input /tmp/agenc-main-local-required.json
   gh api "repos/tetsuo-ai/agenc-core/rulesets/$RULESET_ID" \
     -H "X-GitHub-Api-Version: 2026-03-10" |
     node scripts/local-gate-ruleset.mjs \
       --verify --app-id "$APP_ID" --enforcement disabled --source app
   ```

6. Before activation, inventory every repository and parent branch ruleset plus
   legacy `main` branch protection. GitHub aggregates overlapping rulesets and
   branch protection; a correct new ruleset does not replace an older hosted
   requirement. The policy tool explicitly rejects the historical
   `agenc-m0-required` hosted check and fails closed on every other required
   check context. The sole permitted required check is the App-bound
   `agenc-local-required-v1` in this disabled ruleset. Other non-status rules,
   such as reviews or signed commits, are unaffected.

   Use a current `gh`, `jq`, and Bash with an operator credential that has
   repository Administration read/write. Run this as one transaction. It
   captures all paginated rulesets, fetches every full ruleset, records an
   explicit HTTP 200 or 404 for legacy protection, refuses an inventory older
   than five minutes, activates only from that inventory, and then re-reads the
   effective layered policy:

   ```bash
   set -euo pipefail
   umask 077
   repo="tetsuo-ai/agenc-core"
   api_version="2026-03-10"
   audit_dir="$(mktemp -d)"
   trap 'printf "cutover evidence retained at %s\n" "$audit_dir" >&2' EXIT

   capture_legacy_main_protection() {
     local output="$1" raw body status rc
     raw="$(mktemp "$audit_dir/legacy-raw.XXXXXX")"
     body="${raw}.body"
     set +e
     gh api --include "repos/$repo/branches/main/protection" \
       -H "X-GitHub-Api-Version: $api_version" >"$raw"
     rc=$?
     set -e
     status="$(awk 'NR == 1 { print $2 }' "$raw")"
     case "$status:$rc" in
       200:0)
         awk '
           body { print }
           {
             line = $0
             sub(/\r$/, "", line)
             if (line == "") body = 1
           }
         ' "$raw" >"$body"
         jq -e . "$body" >/dev/null
         jq -n --slurpfile body "$body" \
           '{status: 200, body: $body[0]}' >"$output"
         ;;
       404:*)
         jq -n '{status: 404, body: null}' >"$output"
         ;;
       *)
         echo "legacy branch-protection read failed with HTTP ${status:-unknown}" >&2
         return 1
         ;;
     esac
     rm -f "$raw" "$body"
   }

   inventory_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
   gh api --paginate --slurp \
     "repos/$repo/rulesets?includes_parents=true&targets=branch&per_page=100" \
     -H "X-GitHub-Api-Version: $api_version" \
     >"$audit_dir/ruleset-pages.json"
   jq -e 'type == "array" and length > 0 and all(.[]; type == "array")' \
     "$audit_dir/ruleset-pages.json" >/dev/null

   : >"$audit_dir/ruleset-details.ndjson"
   while IFS= read -r ruleset_id; do
     gh api "repos/$repo/rulesets/$ruleset_id?includes_parents=true" \
       -H "X-GitHub-Api-Version: $api_version" \
       >>"$audit_dir/ruleset-details.ndjson"
     printf '\n' >>"$audit_dir/ruleset-details.ndjson"
   done < <(jq -er '.[][] | .id' "$audit_dir/ruleset-pages.json")
   jq -s . "$audit_dir/ruleset-details.ndjson" \
     >"$audit_dir/ruleset-details.json"
   capture_legacy_main_protection "$audit_dir/legacy-before.json"

   jq -n \
     --arg captured_at "$inventory_started_at" \
     --arg repo "$repo" \
     --slurpfile pages "$audit_dir/ruleset-pages.json" \
     --slurpfile details "$audit_dir/ruleset-details.json" \
     --slurpfile legacy "$audit_dir/legacy-before.json" \
     '{
       schema_version: 1,
       repository: $repo,
       branch: "main",
       captured_at: $captured_at,
       query: {
         endpoint: ("repos/" + $repo + "/rulesets"),
         includes_parents: true,
         targets: "branch",
         per_page: 100,
         paginated: true,
         page_count: ($pages[0] | length)
       },
       listed_rulesets: ($pages[0] | add),
       rulesets: $details[0],
       legacy_main_protection: $legacy[0]
     }' >"$audit_dir/cutover-inventory.json"

   node scripts/local-gate-ruleset.mjs \
     --verify-cutover --app-id "$APP_ID" --ruleset-id "$RULESET_ID" \
     <"$audit_dir/cutover-inventory.json" |
     tee "$audit_dir/cutover-verification.json"

   node scripts/local-gate-ruleset.mjs \
     --render --app-id "$APP_ID" --enforcement active --source app \
     --ruleset-id "$RULESET_ID" \
     --cutover-inventory "$audit_dir/cutover-inventory.json" \
     >"$audit_dir/active-ruleset.json"
   gh api --method PUT "repos/$repo/rulesets/$RULESET_ID" \
     -H "X-GitHub-Api-Version: $api_version" \
     --input "$audit_dir/active-ruleset.json" \
     >"$audit_dir/active-update-response.json"
   gh api "repos/$repo/rulesets/$RULESET_ID" \
     -H "X-GitHub-Api-Version: $api_version" |
     tee "$audit_dir/active-readback.json" |
     node scripts/local-gate-ruleset.mjs \
       --verify --app-id "$APP_ID" --enforcement active --source app |
     tee "$audit_dir/active-readback-verification.json"

   effective_started_at="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
   gh api --paginate --slurp \
     "repos/$repo/rules/branches/main?per_page=100" \
     -H "X-GitHub-Api-Version: $api_version" \
     >"$audit_dir/effective-pages.json"
   jq -e 'type == "array" and length > 0 and all(.[]; type == "array")' \
     "$audit_dir/effective-pages.json" >/dev/null
   capture_legacy_main_protection "$audit_dir/legacy-after.json"
   jq -n \
     --arg captured_at "$effective_started_at" \
     --arg repo "$repo" \
     --slurpfile pages "$audit_dir/effective-pages.json" \
     --slurpfile legacy "$audit_dir/legacy-after.json" \
     '{
       schema_version: 1,
       repository: $repo,
       branch: "main",
       captured_at: $captured_at,
       query: {
         endpoint: ("repos/" + $repo + "/rules/branches/main"),
         per_page: 100,
         paginated: true,
         page_count: ($pages[0] | length)
       },
       rules: ($pages[0] | add),
       legacy_main_protection: $legacy[0]
     }' >"$audit_dir/effective-main.json"
   node scripts/local-gate-ruleset.mjs \
     --verify-effective --app-id "$APP_ID" --ruleset-id "$RULESET_ID" \
     <"$audit_dir/effective-main.json" |
     tee "$audit_dir/effective-verification.json"
   ```

   If the pre-activation verifier names a stale or unexpected context, update
   that exact source ruleset or legacy branch-protection object from its fresh
   readback, keep the local ruleset disabled, and restart this transaction.
   Never treat a 403, network failure, partial page, or missing full ruleset as
   equivalent to “no policy.” At no point may the any-source bootstrap be
   active. Archive the mode-`0700` evidence directory after success. If a
   command fails after the active `PUT`, protection remains active but unproven:
   stop the cutover, preserve the directory, and either complete a fresh
   effective verification or use the separately reviewed break-glass procedure
   to return the ruleset to disabled before restarting.

7. Create a disposable same-repository PR at a new unattested SHA and prove it
   cannot merge. Publish a local `failure` and prove it remains blocked. Under
   this publisher's two-outcome contract, only its genuine App-owned local
   `success` for the current SHA may satisfy the rule. Close the proof PR
   without merging.

GitHub's native required-check rule treats `success`, `neutral`, and `skipped`
as passing. This publisher emits only `success` or `failure`, and source binding
prevents another App from substituting the context. Release verification is
stricter still: it accepts literal `success` only and validates the canonical
receipt.

If GitHub creates a test-merge commit and a check is attached to it, GitHub can
require that merge SHA rather than the PR head. The deployment proof must
confirm the repository's actual merge mode. The App always publishes to the
exact SHA in its receipt; a prior SHA never authorizes a newer one.

## Release enforcement

[`publish-npm.yml`](../.github/workflows/publish-npm.yml) and
[`release-runtime.yml`](../.github/workflows/release-runtime.yml) continue to
use GitHub-hosted jobs to produce release artifacts. They do not run tests.
Before artifact work starts, each workflow:

1. binds dispatch to the immutable `agenc-v<version>` tag, exact SHA, and
   `main` ancestry;
2. reads the configured gate App ID; and
3. requires exactly one completed App-owned `agenc-local-required-v1` literal
   success for that exact SHA, current policy digest, canonical receipt, and
   `main` subject.

A PR-head receipt cannot release a squash-merged commit. A missing, stale,
duplicate, wrong-App, wrong-SHA, PR-subject, failed, neutral, skipped, or
malformed result blocks release before artifact production.

## Required policy-context rotation

GitHub matches a required check by context and App; it cannot inspect the
policy digest inside AgenC's receipt. Reusing a context after changing
`approvedContractSha256` could therefore let an earlier green check satisfy the
new policy. Every approved policy-digest change must increment
`REQUIRED_GATE_CONTEXT` by exactly one epoch, from
`agenc-local-required-vN-1` to `agenc-local-required-vN`. The ruleset name is
derived from that context. Epochs must never be reused, skipped, or rolled back.

Do not install policy B while policy A's context is still required. Do not
disable branch protection, activate an any-source rule, or leave the old
context as an alternative. Use this fail-closed rotation:

1. Independently review policy B, including the one-epoch context bump, and
   stage it root-owned at `POLICY_B_ROOT` without the App credential. Do not yet
   replace the active trusted mirror or its approved digest.
2. Using B's renderer and an operator Administration credential, create a
   *separate disabled* any-source bootstrap ruleset for vN. The old App-bound
   vN-1 ruleset remains active throughout.
3. Through a separately reviewed App-credentialed seeder that can only publish
   `failure`, emit a genuine vN Check Run. This satisfies GitHub's recent-check
   source-eligibility prerequisite without creating a result that could
   unblock a merge. Update the disabled bootstrap to `--source app` and verify
   its readback. A general arbitrary-context publisher or success-capable
   seeder is forbidden.
4. Capture a new complete inventory using the exact paginated transaction in
   initial cutover step 6. It must contain exactly the active App-bound vN-1
   ruleset and the separate disabled App-bound vN bootstrap, with no legacy or
   other required context. Verify that inventory with B's policy tool.
5. Use that same fresh inventory to render vN, then atomically `PUT` it over the
   *existing active ruleset ID*. vN becomes blocking immediately; no vN success
   exists yet. If any later command fails, leave vN active and stop—never fall
   back to vN-1.
6. Verify the active vN readback, delete the disabled bootstrap, and prove its
   ID is absent from a fresh complete ruleset listing. Re-capture effective
   `main` rules and legacy protection exactly as in initial cutover step 6, then
   verify that vN is the sole required check.
7. Only now install policy B and its independently approved digest. Attest the
   policy PR under vN, merge it, install and attest the resulting `main`, then
   rerun every open same-repository PR. Old vN-1 results remain historical and
   cannot satisfy vN.

Create and bind the disabled bootstrap with B's reviewed, credential-free
renderer. The failure-only seeder must run between these two payloads:

```bash
node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
  --render --app-id "$APP_ID" --enforcement disabled --source any \
  >"$audit_dir/bootstrap-any-vN.json"
gh api --method POST "repos/$repo/rulesets" \
  -H "X-GitHub-Api-Version: $api_version" \
  --input "$audit_dir/bootstrap-any-vN.json" \
  >"$audit_dir/bootstrap-create-response.json"
BOOTSTRAP_RULESET_ID="$(jq -er '.id' \
  "$audit_dir/bootstrap-create-response.json")"

# Run the reviewed failure-only vN seeder here. Do not continue unless its
# App-owned failure Check Run has been read back for the exact seeded SHA.
sudo systemctl start agenc-local-gate-context-seed@seed.service
sudo journalctl -u agenc-local-gate-context-seed@seed.service

node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
  --render --app-id "$APP_ID" --enforcement disabled --source app \
  >"$audit_dir/bootstrap-app-vN.json"
gh api --method PUT "repos/$repo/rulesets/$BOOTSTRAP_RULESET_ID" \
  -H "X-GitHub-Api-Version: $api_version" \
  --input "$audit_dir/bootstrap-app-vN.json" \
  >"$audit_dir/bootstrap-bind-response.json"
gh api "repos/$repo/rulesets/$BOOTSTRAP_RULESET_ID" \
  -H "X-GitHub-Api-Version: $api_version" |
  tee "$audit_dir/bootstrap-app-vN-readback.json" |
  node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
    --verify --app-id "$APP_ID" --enforcement disabled --source app
```

[`local-gate-context-seed.mjs`](../scripts/local-gate-context-seed.mjs) derives
the next context by exactly one epoch (`v1` to `v2` in the current policy). It
is hard-bound to this repository, `refs/heads/main`, the installed policy-A
context and digest, and the derived next context. Its CLI accepts neither a
SHA, context, nor conclusion. The credential-free static parent creates a
short-lived root-owned handoff and starts a random, parent-bound credential
child under `system-agencgate.slice`; only that child receives the encrypted
App key.

Before it reads the key, immediately before publication, and after readback,
the child requires the same current `main` SHA. It paginates every suite page
filtered to the configured App and next context, then every returned suite's
filtered Check Runs, so more than 1,000 matching suites cannot hide a duplicate
behind the Git-reference API's truncation. Seeding requires exactly zero
matching checks before its sole
`POST`, then a GET-by-ID and a fresh complete inventory containing exactly one.
The body is fixed to `completed`/`failure`; its canonical summary and bounded
external ID carry the purpose, repository/main SHA, policy-A context and
digest, next context, and timestamp. It never calls `PATCH` and does not use
the ordinary gate receipt or publisher.

The encrypted credential's sole operational custody must remain this host;
the local flock cannot serialize an independent remote holder of the same App
key. A concurrent App write makes the exact-one postcondition fail closed. In
that case leave the bootstrap disabled, preserve the App audit evidence, remove
the unauthorized credential path, and independently review the resulting
checks before deciding whether a new policy epoch is required. Never delete or
rewrite a seed merely to force the count back to one.

If the create request may have succeeded but its final readback was interrupted,
do not rerun `seed`: its zero-check precondition will fail. Use the read-only
repository recovery verifier, which accepts only one exact existing seed and
never creates or updates a Check Run:

```bash
sudo systemctl start agenc-local-gate-context-seed@recover.service
sudo journalctl -u agenc-local-gate-context-seed@recover.service
```

Then perform the guarded active transition:

```bash
# ROTATION_INVENTORY is a fresh full inventory produced by the step-6 capture
# transaction after the disabled vN bootstrap has been App-bound.
node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
  --verify-policy-rotation --app-id "$APP_ID" \
  --ruleset-id "$RULESET_ID" \
  --bootstrap-ruleset-id "$BOOTSTRAP_RULESET_ID" \
  <"$ROTATION_INVENTORY"

node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
  --render --app-id "$APP_ID" --enforcement active --source app \
  --ruleset-id "$RULESET_ID" \
  --bootstrap-ruleset-id "$BOOTSTRAP_RULESET_ID" \
  --policy-rotation-inventory "$ROTATION_INVENTORY" \
  >"$audit_dir/active-vN-ruleset.json"

gh api --method PUT "repos/$repo/rulesets/$RULESET_ID" \
  -H "X-GitHub-Api-Version: $api_version" \
  --input "$audit_dir/active-vN-ruleset.json" \
  >"$audit_dir/active-vN-update-response.json"

gh api "repos/$repo/rulesets/$RULESET_ID" \
  -H "X-GitHub-Api-Version: $api_version" |
  tee "$audit_dir/active-vN-readback.json" |
  node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
    --verify --app-id "$APP_ID" --enforcement active --source app

gh api --method DELETE "repos/$repo/rulesets/$BOOTSTRAP_RULESET_ID" \
  -H "X-GitHub-Api-Version: $api_version"
gh api --paginate --slurp \
  "repos/$repo/rulesets?includes_parents=true&targets=branch&per_page=100" \
  -H "X-GitHub-Api-Version: $api_version" \
  >"$audit_dir/ruleset-pages-after-bootstrap-delete.json"
jq -e --argjson id "$BOOTSTRAP_RULESET_ID" \
  'type == "array" and length > 0 and all(.[]; type == "array") and
   all(.[][]; .id != $id)' \
  "$audit_dir/ruleset-pages-after-bootstrap-delete.json" >/dev/null

# Rebuild effective-main.json from fresh API reads as in initial cutover, then:
node "$POLICY_B_ROOT/scripts/local-gate-ruleset.mjs" \
  --verify-effective --app-id "$APP_ID" --ruleset-id "$RULESET_ID" \
  <"$audit_dir/effective-main.json"
```

GitHub also requires the expected-source App to have emitted the context
recently and the context to pre-exist as required before source binding. The
failure-only next-context seeder supplies only that eligibility record; the
live source-binding flow still must be independently reviewed and proven.
Installing B early to make its ordinary publisher seed vN is not an acceptable
workaround.

## Developer reproduction and policy changes

Provision the digest-pinned image outside the no-network boundary, then use a
clean checkout:

```bash
image="$(node -p 'require("./release-toolchain.json").docker.buildImage')"
docker pull "$image"
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 esbuild node-pty
npm run check:required-gates
```

That direct command is a developer reproduction. Only the root-installed
dispatcher with separate worker/Docker identities can issue an authoritative
App receipt. Run the focused policy suite with:

```bash
npm run test:required-gates
```

When a hashed policy file changes, independently review the diff, run local
gates, and follow the required policy-context rotation above. Install the
reviewed trusted mirror and update the root-owned digest only at rotation step
7. Never copy a digest from candidate output merely to make a PR pass.

The audited break-glass path is to disable the ruleset out of band, land only a
separately reviewed repair, attest the resulting `main` SHA locally, restore
the exact App-bound ruleset, and rerun the negative proof. Leaving protection
disabled, admin-merging unrelated work, or publishing a user-owned status is
not rollback.

## Current deployment evidence

The repository policy tests and PTY supervisor run locally in ordinary
development mode. This checkout does not have the required dedicated rootless
Docker account/socket, so it cannot claim the authoritative multi-UID systemd
and encrypted-credential end-to-end proof. Policy-context rotation still
requires the dedicated-host seeder and source-binding proof described above.
Do not mark the M0 attestation item complete until the dedicated-host proof,
live App readback, active ruleset readback, and blocked-unattested-SHA proof are
recorded.

## Primary sources

Research refreshed 2026-07-15:

- [GitHub Check Runs API](https://docs.github.com/en/rest/checks/runs?apiVersion=2026-03-10#list-check-runs-for-a-git-reference)
  documents failure conclusions, GET-by-ID readback, suite-run `check_name`,
  `filter=all`, and 100-item pagination.
- [GitHub Check Suites API](https://docs.github.com/en/rest/checks/suites?apiVersion=2026-03-10#list-check-suites-for-a-git-reference)
  documents exact-ref Check Suite enumeration and 100-item pagination.
- [Ruleset REST API](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10#create-a-repository-ruleset)
  defines `required_status_checks`, `integration_id`, strictness, branch
  conditions, enforcement, and bypass actors.
- [Ruleset layering](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/about-rulesets#about-rule-layering)
  documents that matching rulesets and legacy branch protection aggregate and
  that the most restrictive version applies.
- [Effective branch rules](https://docs.github.com/en/rest/repos/rules?apiVersion=2026-03-10#get-rules-for-a-branch)
  return every active ruleset rule that applies to the named branch, including
  organization-level rules; legacy protection is audited separately.
- [Branch protection REST API](https://docs.github.com/en/rest/branches/branch-protection?apiVersion=2026-03-10#get-branch-protection)
  defines the explicit 200/404 readback and legacy required-check shapes.
- [Available rules for rulesets](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets#require-status-checks-to-pass-before-merging)
  documents expected-source App selection and its installed
  `statuses:write` prerequisite.
- [GitHub App manifest parameters](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest#github-app-manifest-parameters)
  define private visibility, installed permissions, and empty event
  subscriptions for the versioned App registration.
- [Installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
  document repository and permission narrowing below installed App grants.
- [Troubleshooting required checks](https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/collaborating-on-repositories-with-code-quality-features/troubleshooting-required-status-checks)
  documents latest-SHA, merge-commit, conclusion, name-collision, and freshness
  behavior.
- [GitHub App JWT authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
  defines RS256 identity and bounded claims.
- [systemd credentials](https://systemd.io/CREDENTIALS/) defines encrypted,
  service-scoped secret delivery.
- [systemd service sandboxing](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
  defines filesystem, identity, capability, namespace, and resource controls.
- [Docker rootless mode](https://docs.docker.com/engine/security/rootless/)
  defines the unprivileged daemon and user-socket boundary.
- [npm 11 `npm ci`](https://docs.npmjs.com/cli/v11/commands/npm-ci/)
  defines frozen-lockfile installs.

GitHub-hosted test execution was rejected because it spends remote runner time
without strengthening the local hermetic boundary. A generic signed file or
PAT-owned status was rejected because the protected context could not be bound
to one dedicated producer. The App design keeps all expensive computation
local while GitHub stores and enforces only the authenticated exact-SHA result.
