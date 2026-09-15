# Execution environment implementation ledger (#2477)

The approved plan in the implementation thread is the acceptance contract. This
ledger records implementation and evidence; unchecked entries are not delivered
guarantees. Existing local execution remains local and does not provide controller
survival against a workload in the same PID namespace.

## Requirements and proof

| ID | Requirement | Implementation / integration locations | Dependencies | Required evidence | Status / remaining work |
| --- | --- | --- | --- | --- | --- |
| E1 | Explicit local and Docker process and filesystem environments; backend-owned operations replace host-spawn callbacks | `runtime/src/execution/`, `sandbox/execution-prepared-spawn.ts`, `sandbox/execution-broker.ts`, `unified-exec/process-manager.ts` | H1–H5 | Backend contract tests; unsupported operations fail before dispatch | Docker environment joins process/filesystem authority; public unified-exec manager delegates selected launches and lifecycle operations to an environment manager. Explicit local environment and prepared-spawn callback migration remain pending |
| E2 | Operator CLI `--execution-container`, SDK/session `executionTarget`, daemon negotiation, immutable ID and generation before project reads | `bin/agenc-main.ts`, session bootstrap/configuration/services, app-server, SDK | E1, H4 | Bootstrap ordering, foreign/stale generation, child inheritance tests | Config repository/store accept an explicitly bound task filesystem, including root discovery and retired-input checks. Bootstrap still needs binding before shell/cwd/config discovery; CLI/SDK/daemon selection and child inheritance remain pending |
| E3 | Environment identity in workspace caches and editor state | workspace, editor, project/config/skills caches | E2, F1 | Two containers with separate `/app`; stale capabilities and editor conflicts | Tiered instruction cache keys, path evidence, live prompt heads and project-memory storage/cache keys include environment identity. Plugin package/skill-root discovery preserves binding and separates equal controller/task paths and dependency outcomes. Plugin registration cache identity includes the environment, with protected reload for task sources. Local skill sources, invocation records, protected reload and command-service caches now retain environment identity; constructors forward the owning ConfigStore binding. Protected role content and generation-bound role workspace/catalog identity are implemented; daemon/SDK role provenance transport and in-memory TUI role state now preserve binding; coordinator paths and persistence are environment-partitioned with protected preparation. Daemon content-capability bootstrap, editor ingress/transport, overlay provenance and remaining workspace caches are pending |
| H1 | Persistent host supervisor; additive Docker custom runtime adapter delegating qualified runc 1.5.1 | `runtime/native/execution-host/`, installer, service/config artifacts | Supported Linux Docker fixture | Real Docker create/exec/healthcheck/lifecycle, supervisor survives task signals | Host RPC supervisor/runtime adapter implemented and exercised in nested Docker; production installer/service and full qualification pending |
| H2 | Host-owned command cgroup and one-use lease before Docker exec creation; immutable owner, authority revision, run/call/attempt, resolved spec | Host supervisor and runtime adapter | H1 | Invalid/stale/duplicate/replayed leases and missing cgroups execute no instructions | Durable lease/authority store and exact adapter spec check implemented; controller dispatch and broader fault tests pending |
| H3 | Atomic unclaimed revocation; claimed-launch cancellation fence; cleanup only after launch cannot populate and cgroup is empty | Host supervisor, native/runtime launch scopes | H2 | Cancellation before claim, during exec and after initial empty observation | Separate launch/command scopes implemented; before-claim and running cancellation pass; deterministic in-flight injection pending |
| H4 | Generation and supported-profile validation; reject privileged/host namespaces, remapping, custom LSMs, controller mounts and control sockets | Host preflight and environment binding | H1 | Negative profile fixtures and generation death tests | Pending |
| H5 | Preserve Docker aggregate limits, init/services in parent, empty subtree_control; detached environment scopes | Supervisor, Docker adapter, detached exec | H2–H4 | Fork/double-fork/setsid cleanup; healthchecks and persistent services survive managed cleanup | Native detached task logs and task PID receipts implemented; owner close, graceful/SIGKILL supervisor restarts, double-fork/setsid service survival and strict explicit cleanup pass in disposable Docker. Complete deployment/AppArmor and session/Harbor qualification remain open |
| F1 | Immutable native worker outside task PID namespace; pinned mount/root, explicit root/cwd replacement, setup authority dropped | Native filesystem worker and environment filesystem client | H4 | Root self-termination survival; descriptor/bootstrap authority tests | Static native worker and private descriptor bootstrap implemented; root self-kill/broad signals and capability/seccomp checks pass; fixed AppArmor policy and installer qualification pending |
| F2 | Existing bound reads and transaction guards, openat2 task-root containment, absolute symlinks, held identities, special-resource rejection | Native worker; `workspace/file-mutation-transaction.ts`; `execution/docker-filesystem.ts`, `execution/docker-ripgrep.ts` | F1 | Symlink and parent swaps, mutation acknowledgements/conflicts, special resources | Bound reads/text windows, file guards, directory mutations and bound task search use native capabilities and managed execution. Original inode retention, recreate/rollback, rename/delete, partial failure and parent swaps verified. Exclusive protected directory creation with admitted receipts and parent-swap fencing is implemented and kernel-verified. Shared bound-read/directory-mutation/file-guard factories now select the backend. Selected transactions retain one-use preflight guards and reconcile lost acknowledgements without rollback. Guards capture absent ancestors and the admitted write creates them exclusively through held parents with partial-creation evidence (worker protocol 9, kernel-verified). Remaining general primitives/limits and caller migrations remain pending |
| M1 | Shell/PTY/detached commands and every task helper execute in environment | unified-exec, supervisedProcess, direct command helpers | E1–E2 | Exact argv/env/cwd, binary stdin/Unicode/EOF/resize; execution ingress inventory | Selected manager supports shell/PTY and detached services without host fallback; task log/PID, owner propagation, early exit, cancellation, no stdin replay and service shutdown behavior verified. Bootstrap injection and migration of all helpers remain pending |
| M2 | File tools, patching, search, Git, editor and configuration/instructions/skills/roles use environment filesystem | tools, workspace, config, skills, roles, editor | E2, F2 | Shared shell/file view; complete ingress coverage | Project/local/explicit task TOML, root markers and retired project-input metadata route through the selected filesystem; controller user/managed settings remain local. Secure instructions, includes, bounded rules and live prompt/persona reads use selected filesystem authority. Config reload publishes protected task Git-root metadata with its snapshot; controller memory storage/extraction use the same environment-scoped key. Plugin package discovery, manifests, component enumeration and retired-file inspection accept protected task filesystem authority. Plugin command/skill/agent/output-style content registration uses bound reads and validates source bindings. Local skill discovery, content reads, dynamic roots and protected metadata watches use per-source authority; user/managed/bundled sources retain controller reads. Skill service constructors forward existing workspace authority. Protected shared Markdown tiers, task TOML role capture, and asynchronous task agent-memory prompt capture are implemented. Actual selected text/notebook reads and protected approval previews are integrated. Selected Write, Edit and MultiEdit use protected preflight, retained guards, coordinator admission, protected ancestor creation and verified post-write snapshots; editor overlays and LSP feedback remain open. Operator bootstrap selection, remaining role consumers/daemon content bootstrap, agent-memory mutations/permissions and snapshot synchronization, legacy instruction attachments, apply_patch/NotebookEdit and other tool migrations are pending |
| M3 | Hooks, stdio MCP, LSP, browsers and conversions use environment; provider credentials/canonical state/external integrations stay controller-side; no implicit controller env | sandbox broker, hooks, mcp, lsp, browser, conversion helpers | M1–M2 | Bypass enforcement and credential separation tests | Pending |
| P1 | Owner-scoped numeric list_processes; no output consumption; strict awaited kill and retained final output | tools/system, unified-exec, tool registry/profiles/prompts | E1, H3 | Concurrent owner list/poll/kill, stale handles, cleanup failures | Local/environment ownership, durable host IDs and receipt-store fencing verified. Public manager restoration and checkpoint handle/cursor transport implemented; a real fixture controller SIGKILL/restart preserves original handles, split UTF-8 output and exactly one launch/EOF. Full session bootstrap and lifecycle integration remain pending |
| R1 | Operational receipts/output in supervisor, canonical writer in controller; reconnect original operation without replay or duplicate input; sticky unknown_outcome | host receipts, controller effect/admission integration | H1–H3, E1 | Failures around dispatch/start/output/input/mutation/canonical settlement | Supervisor dispatch, indexed binary output cursors, input receipts, owner-close fence and Docker process reconnection implemented; canonical integration and remaining failure windows pending |
| R2 | Quarantine unproven cleanup; environment death invalidates handles/generation, inspectable failure, no automatic reprovision/replay; user interrupt cascade | Environment lifecycle and session integration | H3–H4, R1 | Runtime death/quarantine/cancellation tests | Environment manager fences owner authority after uncertain launch/input or cleanup/output failure and retains failure metadata; complete session/canonical recovery and generation-loss integration pending |
| R3 | Checkpoint v5 and rollout schema v6, reader/writer/validator/SDK upgrades; old sessions local | session event-log/checkpoint/rollout/store, SDK | E2 | Version compatibility and recovery tests | Binding and acknowledged manager handle/cursor persistence implemented in v5/v6, with strict parsing, legacy-local upgrades, writer and orphaned-turn resume transport. Restored output comes from original receipts; closed admission and absolute timeouts persist. Operator SDK/bootstrap, recovery across later canonical effects and revoked/dead environment inspection remain pending |
| A1 | Exact stdin prompt, idle cancellation, bounded private native bootstrap; preserve target argv/env/stdin/readiness | prompt-stdin, agenc-main, supervisedProcess, native process broker | None | Exact-byte and cancellation tests; broker failure windows | Earlier changes present; reverify |
| B1 | External Harbor agent, repository Docker environment adapter selects runtime before creation, stdin instruction and external canonical logs; preserve grading/image/resources/network/services | `runtime/eval/harbor/` | E1–E3, H1–H5, M1–M3 | Actual Harbor grading, preflight failure without installed fallback | Pending; existing adapter remains installed-agent |
| D1 | Ship host supervisor, worker, runtime, additive installer, preflight, fixed worker AppArmor policy, docs | packaging, runtime build/native, docs | H1–H5, F1–F2 | Fresh install/preflight, supported AppArmor modes; default runtime unchanged | Pending |
| V1 | Original task-root `/proc` filename cleanup: controller, supervisor, worker, canonical log and subsequent call survive | Isolated Docker kernel fixtures | All integration | End-to-end fixture with all five observations | Pending; old argv-only test is insufficient |
| V2 | Signals, forks, launch races, ownership, recovery, filesystem, compatibility, Harbor and complete ingress coverage | Hermetic and kernel suites | Above | Named acceptance tests with zero skips | Pending |
| V3 | Typecheck, affected checks, full hermetic suite, correctly provisioned kernel suite, real benchmark recapture | Repository gate/benchmark runners | Final implementation | Full commands/results; no skipped qualification | Pending; prior runs are not current qualification |

## Initial source audit

- Initially inspected HEAD `f037754766c3`; worktree contained the earlier local process and
  stdin/bootstrap changes. No execution environment, external supervisor,
  runtime adapter or protected filesystem worker exists at this point.
- `SandboxPreparedSpawn` exposes four host-command callback interfaces, including
  synchronous and lifecycle spawns. They must be replaced at integration, not
  treated as an isolation boundary.
- `unified-exec/process-manager.ts` directly launches PTYs, detached processes
  and contained local processes. Its local manager needs an environment-backed
  process interface.
- `workspace/file-mutation-transaction.ts` embeds JavaScript helpers and performs
  host filesystem operations. Its bound read interface also launches ripgrep;
  the protected worker must instead return a bound capability to environment
  execution, never launch task-controlled code itself.
- A first source inventory found 425 references to filesystem imports/process
  launches/prepared spawn interfaces (`/tmp/agenc-execution-ingress-audit.txt`).
  This is a search inventory, not proof of coverage. Classification and a
  checked-in enforcement rule remain required.
- Canonical effect contracts are documented in
  `docs/design/durable-runs-effects-events.md`; isolated execution must retain
  their sticky review requirement and dispatch-based uncertainty semantics.
- The host has rootful Docker/cgroup v2 with systemd and runc 1.3.4. Qualification
  requires a disposable Docker host with the new additive runtime and pinned
  runc 1.5.1. No host daemon configuration has been changed.

## Continuation

The host implementation now has bounded private Unix RPC, kernel peer
credentials, SQLite operational receipts with FULL synchronization, immutable
environment binding, authority revisions, one-use leases, descriptor-bound
cgroups, a runtime-launch fence, and runc pidfd receipt handling. The adapter
preserves ordinary Docker OCI operations and the task process security fields.
The host component currently uses Python's standard library (Python 3.11+);
installer/preflight packaging must provision and qualify this dependency with an
isolated interpreter and immutable module path. The protected filesystem worker
is now static native code; it executes no task programs. See
`runtime/native/execution-host/README.md` for its private protocol and authority
boundaries.

Current evidence (2026-09-13 America/Edmonton):

- `python3 -B -m unittest discover -s runtime/tests/execution-host -v`:
  **26 passed**, zero skips. Protocol, leases, owner/authority checks, replay
  rejection, missing-scope quarantine, runtime argument preservation and
  negative Docker profile cases. These are not kernel-containment evidence.
- `python3 -B runtime/tests/execution-host/run-kernel-probe.py --log-dir
  /tmp/agenc-execution-host-qualified`: **passed** on a fresh disposable nested
  Docker 29.1.3 daemon using pinned runc 1.5.1, cgroup v2, private task namespaces,
  task UID/GID 0 and AppArmor disabled. The runner removes its fixture and checks
  that the outer Docker runtime registration/default did not change.
- Kernel probe proves managed exec/pidfd receipt/strict cleanup, atomic
  revocation before claim with no task instructions, filename-matching `/proc`
  self-kill plus a subsequent managed call, double-fork/setsid cleanup, foreign
  owner denial, running cancellation/stale stop, and persistence of ordinary
  Docker services. Evidence is in `/tmp/agenc-execution-host-qualified/`.
- The test controller is a fixture process outside the task. It is **not yet
  an AgenC session**, and this probe does **not** establish protected-worker or
  canonical-journal survival. V1 remains pending.
- A real cancellation window was observed: runc can return before its adapter
  has returned to Docker. Cancelling then yields Docker OCI failure 128 despite
  the task having started. A later cancellation yields 137. The canonical
  integration must use receipts and dispatch uncertainty, never infer no effect
  from Docker's launch-error status or automatically replay.
- The native runtime helper SHA-256 pin for this x86_64 fixture is
  `177df879d50c913eb205e898d5c1c05a18f574053c0ce5524c471208eaf06f6f`, checked against
  the runc 1.5.1 release checksum file. Full production qualification/installer
  coverage remains pending.
- Supervisor-owned Docker dispatch now passes the same fresh-host probe with
  binary stdin, Unicode, EOF, separate stdout/stderr, removal of the reserved
  environment marker, repeated acknowledgement without duplicate input,
  non-consuming output cursors and original operation lookup. Reusing a
  run/call/attempt refuses a second dispatch. Latest evidence is in
  `/tmp/agenc-execution-host-dispatch/`.
- The host contract tests are included in the repository's hermetic Vitest
  boundary through `tests/execution-host/host-contract.test.ts`; its focused run
  passed. This does not replace the full hermetic or kernel suites.
- `PATH=/tmp/agenc-node-26.5.0/bin:$PATH npm run typecheck`: passed, including
  test-support typecheck. `git diff --check`: passed. No disposable Docker
  fixtures remain running after verification.

Additional evidence (2026-09-13 America/Edmonton):

- The native worker changes only mount namespace, explicitly replaces root/cwd,
  retains only DAC override/read-search and file-owner capabilities (CapEff=14),
  and applies no_new_privs plus a syscall allowlist excluding execution, fork,
  signals, mounts and namespace changes. Readiness follows all setup steps.
- File/directory descriptors are resolved with openat2, retained through parent
  renames, and reopened by descriptor over private SCM_RIGHTS without retaining
  host `/proc` authority in the worker. Native snapshots and content staging use
  sealed memfds; writes/removals check expected bytes and held identities.
- Production build now produces `dist/agenc-filesystem-worker` as a static PIE
  and includes host Python modules. `npm run build` passed entrypoint and SDK
  artifact checks. Installer/service/AppArmor packaging remains incomplete.
- `npm run test --workspace=@tetsuo-ai/runtime -- tests/execution-host
  --reporter=dot`: **7 Vitest checks passed**, including the wrapper running all
  **26 Python host contracts**, with zero skips. Typecheck including test support
  also passed. These are focused results; full suites remain required.
- A fresh nested Docker probe using the production static worker passed: native
  worker PID namespace/capability/seccomp checks, shell/file shared view,
  absolute and relative symlinks, sealed binary write/remove/create,
  pseudo-filesystem/FIFO/device rejection before I/O, parent-swap protection,
  stale handles, owner-scoped RPC, durable mutation receipts without replay,
  authority epoch invalidation, separate `/app` workspaces, broad task-root
  SIGKILL, and environment-death denial without reprovisioning. Evidence:
  `/tmp/agenc-execution-host-worker-final/`. This remains a fixture controller;
  actual AgenC session/canonical-journal survival is not yet established.

Next: implement local/Docker environment classes and the existing TypeScript
bound-read/transaction-guard interfaces against the host client, extend native
filesystem operations as their callers require, then bind bootstrap/session
authority and migrate all task entrypoints. Continue host failure-window,
PTY/resize, output/restart and detached-reconnection qualification in parallel
with that integration. Do not enable an isolated session while any task
entrypoint can fall back to controller spawning or host workspace reads.

Remaining host-specific hardening/qualification before integration includes
deterministic launch-window injection, detached reconnection tests, PTY resize,
environment-death signalling to attached clients, bounded operational retention,
and failure injection around Docker/output/input receipt boundaries. A transport
EOF must not be treated as proof that all task output was recovered after a
daemon failure. Profile validation still needs the complete mount/control-socket
audit and standard-AppArmor qualification; the current real fixture uses the
explicitly supported disabled-AppArmor mode.

Process adapter and recovery evidence (2026-09-13 America/Edmonton):

- `runtime/src/execution/docker-process.ts` now negotiates host capabilities,
  binds immutable identity before authorization, refuses a changed persisted
  generation, launches explicit process specifications, reconnects by existing
  run/call/attempt identity, and exposes binary output, stdin, resize and strict
  termination. It imports no host process-launch API and preserves separate
  leader/output/cleanup receipts. It is not yet wired to AgenC session tools.
- Exact-environment qualification exposed two real compatibility issues:
  Docker adds image defaults and runc adds HOME. The adapter now invokes a
  static native launcher inside the already-contained command scope. A sealed
  private memfd supplies exact argv (including independent argv[0]) and env;
  stdin is untouched. The launcher closes its private descriptors and replaces
  its environment before exec. The worker and launcher are packaged together.
- Raw output is fsynced before durable stream-range indexing. Binary cursors
  can resume inside a payload and preserve stdout/stderr separation. A pidfd
  for the original Docker daemon plus complete framing and a terminal Docker
  exec receipt are required for output completion. Daemon death does not
  fabricate output completion or an exit code from successful scope cleanup.
- Authority close is persisted before draining operation scopes; old-revision
  authorization, late leases and new dispatch are denied. Detached scopes
  survive owner close. This does not yet prove detached-service survival across
  supervisor restart: detached stdin/stdout/stderr must be disconnected from
  supervisor-owned pipes and backed by environment-owned log paths.
- The refreshed hermetic execution-host run passed **14 Vitest checks**, including
  **35 Python contracts**, with zero skips. Build/package-entrypoint and SDK
  artifact checks and typecheck passed. The native contracts cover binary stdin,
  exact environment/argv, malformed and unsealed bootstrap rejection before task
  instructions, and the absence of an installed-host-inode descriptor in tasks.
  Final focused logs: `/tmp/agenc-execution-process-identity-hermetic.log`,
  `/tmp/agenc-execution-process-identity-build.log`, and
  `/tmp/agenc-execution-process-identity-typecheck.log`.
- A fresh disposable host using both production static binaries passed the
  existing signal/filesystem cases plus exact env, alternate argv[0], empty and
  Unicode argv, non-consuming binary output cursors, PTY input/resize/output,
  authority-close fencing and detached-scope preservation. Killing only the
  nested Docker daemon left the supervisor and native worker alive, retained
  the original output/operation identity, proved command cleanup and kept the
  output outcome explicitly incomplete. Evidence:
  `/tmp/agenc-execution-process-sealed-verified/` (final sealed-launcher probe).
- The daemon-failure fixture now keeps its disposable host alive independently
  of dockerd. Its first attempt omitted Docker-in-Docker's cgroup initialization
  and failed a lease claim with EOPNOTSUPP before task execution. The fixture
  now runs the image's dind initialization before the independent keeper and
  daemon; the complete probe then passed. Outer Docker runtime/default remains
  unchanged and completed fixtures are removed.
- The installed launcher is copied to a sealed anonymous executable before
  handoff. Passing the installed file itself would expose that host inode through
  task `/proc/PID/exe`/fd paths; a task root could retain it and attempt mutation
  after exec. Tests verify distinct identities and seal enforcement. Only the
  immutable copy and sealed bootstrap enter the task, and both private fds close
  before the requested program executes.
- Build and test snapshots share generated artifacts and must run sequentially.
  Concurrent attempts failed during snapshot/build-context traversal before test
  execution. The runner now stages a minimal fixture build context explicitly,
  because the host's legacy Docker builder ignores Dockerfile-specific ignore
  files. The final hermetic and kernel probes ran after the build and passed.

Integration details requiring resolution next:

- `budget/admitted-tool-call.ts` already derives the canonical run/call/attempt
  and fsyncs effect intent before physical dispatch. Pass this authority into
  execution backends; do not create a competing canonical journal.
  Execution identities now retain the canonical 4096-byte UTF-8 call/scope
  limits from `session/tool-result-integrity.ts`; the earlier 256-character
  host bound would incorrectly reject valid existing identities. TypeScript
  and Python contracts cover the shared byte bound and invalid Unicode.
- One tool call can launch multiple helpers or perform a write and rollback.
  Subordinate operation indexes now retain the canonical run/call/attempt;
  see the integration evidence below. Recovery enumerates original operations
  without recomputing or replaying their sequence.
- Complete native directory mutations and TypeScript bound reads/transaction
  guards. Ripgrep belongs in task execution, with a held directory binding;
  neither native-worker execution nor a fresh host pathname resolution is an
  acceptable substitute. Then integrate session/bootstrap, persistence, all
  execution/file paths and external Harbor as required by the ledger.

Filesystem adapter and admitted-operation evidence (2026-09-13 America/Edmonton):

- `budget/admitted-tool-call.ts` now installs an asynchronous call scope after
  the existing canonical effect intent. Process helpers and file mutations can
  allocate distinct subordinate indexes within that run/call/attempt. Scopes
  close when the logical call settles, including for inherited asynchronous
  callbacks. The host client crosses admission immediately before sending its
  bounded frame. This supplies integration authority; actual tool/environment
  routing and canonical unknown-outcome reconciliation remain incomplete.
- SQLite operational receipt migration preserves legacy process and filesystem
  coordinates at index zero, including unsettled intents. A fault after dropping
  the old table rolls the entire migration back. Process and filesystem recovery
  enumerate the original indexed receipts and never launch or mutate. Explicit
  index zero preserves the legacy input acknowledgement key.
- `execution/docker-filesystem.ts` implements the existing bound file/directory
  reads, optional reads, truncation, streaming text windows, file transaction
  guards, observation, write/remove and rollback primitives over owner/generation/
  revision/worker-epoch RPC. Private sealed staging is released after use. It
  imports no filesystem or process-spawn API. Shared error classes were extracted
  so these imports do not initialize the local helpers.
- Native original-state assertions retain the original target inode as well as
  immutable bytes. Recreating a removed file with identical bytes cannot pass
  that assertion. A create now replaces a held unlinked target descriptor as
  soon as the new inode exists, preserving observation/rollback authority even
  when the subsequent write is partial. Kernel cases cover external unlink,
  recreation, subsequent write and original inode rejection.
- Filesystem dispatch and mutation evidence remain distinct: an acknowledged
  native precondition rejection does not mark the transaction as mutated;
  acknowledgement loss conservatively marks it uncertain. Recovery reads the
  retained original effect. This adapter-level behavior is not yet integrated
  with the complete canonical settlement/review path.
- Build and package/SDK artifact checks passed:
  `/tmp/agenc-docker-filesystem-build.log`. Typecheck including test support
  passed: `/tmp/agenc-docker-filesystem-typecheck-2.log`. The affected hermetic
  run passed **195 tests in 8 files**, including **38 Python contracts**, with
  zero skips: `/tmp/agenc-docker-filesystem-affected.log`. It includes existing
  bound-read and mutation-coordinator tests after the shared error extraction.
- The disposable host runner now bundles a real TypeScript controller probe
  and stages the operator's supported Node 26 executable with its private glibc
  loader/libraries. No system libraries in the daemon fixture are replaced.
  Missing or unsupported Node fails qualification rather than skipping it.
- A fresh disposable kernel probe using both packaged static native binaries
  passed all existing cases and the real TypeScript adapters together:
  `/tmp/agenc-docker-filesystem-kernel/`. New observations include shared
  shell/file bytes, Unicode/CRLF text windows, original inode guards, distinct
  write/rollback receipts under one call, native precondition evidence, held
  directory reads after a parent swap, and filesystem access plus a subsequent
  managed call after filename-matching task self-kill. The fixture was removed
  and the outer Docker runtime registration/default stayed unchanged.
- This is still a fixture controller, not an actual AgenC session or canonical
  journal survival test. The adapter explicitly rejects directory mutations
  and held-directory ripgrep before dispatch; these capabilities must be
  completed before isolated sessions are enabled. E2/M1–M3/R3/B1/D1/V1–V3
  remain required. The native 32 MiB snapshot/staging bound also needs
  reconciliation with existing larger apply_patch/edit limits during migration.

Directory mutation evidence (2026-09-13 America/Edmonton):

- Native operations now bind an entry without following its final symlink,
  remove a verified symlink, recursively remove a captured directory and rename
  a verified regular file without overwriting an existing destination. The
  TypeScript `WorkspaceBoundDirectoryMutation` implementation retains the
  caller's verified parent identity, checks source metadata/content and routes
  every mutation through the admitted operation coordinate.
- Deletions relocate the entry into a unique temporary name in the held parent
  and verify the moved inode before traversal. Recursive deletion uses held
  descriptors, does not follow symlinks and bounds depth/work. Parent exchange
  and occupied rename destinations reject before a mutation is reported.
  Failures after relocation retain `mutationStarted: true`; no automatic retry
  or fabricated successful cleanup is returned.
- Filesystem operational intents now retain their original request as well as
  its committed digest. Recovery validates the digest and exposes the original
  temporary name even after a partial directory failure or supervisor reopen.
  Legacy receipts without a retained request remain readable. Owner filtering
  and duplicate-operation rejection remain enforced. These are operational
  receipts; canonical settlement/review integration remains required.
- Private native worker readiness protocol 2 is checked at connection, before
  any mutation, so an older binary cannot silently advertise these operations.
  Package build includes the matching native binary and host modules.
- Typecheck including test support passed:
  `/tmp/agenc-directory-typecheck-2.log`. Build/package and SDK artifact checks
  passed: `/tmp/agenc-directory-build.log`. The affected hermetic run passed
  **197 tests in 8 files**, including **39 Python contracts**, with zero skips:
  `/tmp/agenc-directory-affected.log`.
- A fresh disposable host using both packaged native binaries and the real
  TypeScript adapters passed exclusive rename, occupied destination refusal,
  symlink removal, recursive non-following deletion, retained original request
  and parent-swap rejection: `/tmp/agenc-directory-kernel/`.
- A second fresh host additionally verified that a directory containing a FIFO
  fails explicitly after relocation, retains the exact temporary name and
  partial-mutation receipt, refuses replay under the original coordinate, and
  leaves the worker usable for subsequent reads. All earlier signal, process,
  filesystem, environment-death and daemon-death probes passed as well:
  `/tmp/agenc-directory-failure-kernel/`. Fixtures were removed and the outer
  Docker runtime configuration remained unchanged.
- This still does not prove isolation of an actual AgenC session. Bound task
  search and general filesystem primitives/limits must be finished, then actual
  callers and bootstrap must migrate. The full host lifecycle, persistence,
  installer/LSM/preflight, Harbor, full-suite and canonical-journal acceptance
  requirements remain open in the main ledger.

Held task descriptors and bound search evidence (2026-09-13 America/Edmonton):

- Native worker protocol 3 exports held regular-file and directory descriptions
  over private SCM_RIGHTS. The supervisor retains their original inode/version
  attestations in the command lease and transfers them only when the root
  runtime adapter claims it. The AGL2 native launcher validates all descriptors
  before target execution, then applies held cwd/stdin and closes private fds.
  Missing descriptions cannot be reconstructed from fresh task pathnames.
- Allocation and claim are tested separately on a disposable Docker host:
  original read-capability release and parent swaps preserve the held files;
  revocation of ordinary and detached allocations releases host descriptors and
  denies late execution; changed input before claim executes no target
  instructions. Foreign and released capabilities fail before allocation.
  Evidence: `/tmp/agenc-held-files-kernel/` and the later search probes below.
- `DockerExecutionFilesystem` now runs directory and exact-file ripgrep through
  managed command scopes with held native cwd/stdin. It no longer returns the
  held-search unsupported placeholder. The existing local structured parser was
  extracted intact into `workspace/structured-ripgrep-limiter.ts`; local helper
  code and controller parsing share its fixed repository-owned source. Task
  output is never compiled as code or imported as a module.
- Search supports explicit argv/environment, supplied binary input with unique
  admitted chunk/EOF coordinates, exact-file input, structured line/record/work
  bounds and exclusions, raw output bounds, and private controller output
  spooling. Timeout, caller cancellation, limits and parser failures await
  managed cleanup. Input acknowledgement loss is not resent; cleanup failures
  and incomplete output remain explicit. Spool files are private output
  artifacts, not an alternate task workspace filesystem route.
- Typecheck including test support passed:
  `/tmp/agenc-bound-search-typecheck-2.log`. Build/package entrypoint and SDK
  artifact checks passed: `/tmp/agenc-bound-search-build.log`. The expanded
  affected hermetic run passed **228 tests in 10 files**, including the wrapper
  running **44 Python host contracts**, with zero skips:
  `/tmp/agenc-bound-search-affected.log`. Existing bound-read, grep and ripgrep
  protocol cases passed after the shared parser extraction.
- A fresh disposable host using both packaged native binaries and the actual
  TypeScript adapters passed real ripgrep searches through parent swaps,
  original exact-file input, multi-chunk Unicode input, structured line limits,
  private stdout spooling, and descendant cleanup on timeout/cancellation:
  `/tmp/agenc-bound-search-final-kernel/`. All prior task-signal, filesystem,
  environment-death and Docker-daemon-death cases passed. The fixture was
  removed and outer Docker runtime settings remained unchanged. The runner now
  records the supplied real ripgrep version/digest and fails if it is unavailable.
- This remains a fixture controller, not an AgenC session or canonical journal
  survival proof. The selected tool callers, bootstrap, persistence, complete
  environment classes, detached restart handling, installer/preflight/LSM,
  Harbor, full hermetic/kernel suites and actual benchmark recapture remain
  required. No isolated session flag has been enabled.

Environment and unified-exec integration evidence (2026-09-14 America/Edmonton):

- `DockerExecutionEnvironment` joins the existing process and protected
  filesystem adapters under one immutable owner/container/generation/revision.
  Failed filesystem setup drains the newly authorized owner; no alternative
  environment is selected automatically.
- The actual `UnifiedExecProcessManager` accepts an operator-injected execution
  environment and delegates shell/PTY launch, input, polling, listing,
  termination, shutdown and lifecycle drains to `EnvironmentProcessManager`.
  Its selected path has no host spawn, host PID signalling, cwd probing or
  implicit controller environment/temp-directory inheritance. The existing
  local manager remains available. Prepared-spawn callbacks are still present
  elsewhere and require replacement; this is not complete ingress coverage.
- The environment manager retains output until polling, decodes UTF-8 across
  chunk boundaries, separates leader exit/output completion/cleanup, and awaits
  the backend's strict stop result. A natural exit racing with kill retains its
  completed status. Unknown/already-finished handles return false. Exact owner
  checks prevent foreign listing, input and termination; listing consumes no
  output. Operational failure metadata is separate from numeric task exit.
- Admission is rechecked immediately before backend dispatch. Lifecycle
  quiesce fences a pending pre-dispatch launch, drains it and can then resume.
  A lost launch/input acknowledgement instead fences the owner through the
  supervisor and refuses new dispatch. No command or uncertain input is retried.
  Cleanup/output failure stays explicit and retains the original operational
  receipts. Full canonical settlement/review integration is still required.
- Typecheck including test support passed:
  `/tmp/agenc-environment-manager-final-typecheck.log`. Build, entrypoint and
  SDK artifact checks passed: `/tmp/agenc-environment-manager-build.log`.
  The affected hermetic run passed **149 tests in 20 files**, with zero skips,
  including existing unified-exec, tool ownership, process output, command
  wrapping and broker lifecycle cases: `/tmp/agenc-environment-manager-affected.log`.
  After adding the natural-exit/kill race case, the final focused run passed
  **25 tests in 4 files**, zero skips:
  `/tmp/agenc-environment-manager-final-focused.log`.
- A fresh disposable Docker host using both packaged native binaries and the
  environment-backed manager passed task-root filename self-kill followed by
  another command and protected filesystem read, numeric handle ownership,
  non-consuming listing, strict kill followed by final-output polling, stale
  stop and Unicode PTY input. All prior host/filesystem/search/failure probes
  passed: `/tmp/agenc-environment-manager-final-kernel/`. The fixture was removed;
  the outer daemon's runtime configuration remained unchanged.
- The kernel controller is still a fixture, not an AgenC session/canonical
  journal. Bootstrap does not inject this environment yet and the CLI flag
  remains absent. The environment manager explicitly rejects detached services
  until task log redirection/restart survival is implemented; it cannot use the
  local detached path. It also rejects the initial unsupported permission
  profiles before dispatch. These rejections are pending required capabilities,
  not substitutes for the approved final behavior.

Durable handles and residual-cleanup evidence (2026-09-14 America/Edmonton):

- Numeric handles now originate in the supervisor's SQLite receipt transaction,
  alongside their lease and allocation receipt. The persistent sequence spans
  owners and generations, survives receipt-row retirement and supervisor-store
  reopening, and rejects exhaustion at JavaScript's maximum safe integer before
  committing a launch. Atomic migration retains existing operational rows;
  interrupted backfill rolls back, and missing already-migrated identities fail
  closed instead of being reassigned.
- Docker process launch and canonical-coordinate reconnection expose the same
  retained numeric handle. The actual unified-exec environment manager uses it
  instead of restarting a controller-local counter; pending launches retain a
  separate controller bookkeeping key until acknowledged. A second manager's
  new command cannot alias an old handle, and stale polling/termination cannot
  affect that command.
- Docker environment bindings now include the original process-handle namespace,
  and the environment cache-key helper includes it. Restoring an incomplete or
  replacement-store binding fails before binding or authorization. Every bound
  RPC carries that namespace, including filesystem operations; the supervisor
  checks it before dispatch, covering store replacement after negotiation. This
  does not complete environment-aware caching or session persistence migration.
- Cleanup observes command population only after the runtime launch fence is
  empty and publishes residual termination only after strict command cleanup.
  A persisted leader-exit observation distinguishes leftover descendants from
  cancellation of a live leader. Detached services are excluded. The retained
  receipt reaches the existing unified-exec result/guidance field without
  changing the leader's exit code; failed cleanup cannot fabricate the flag.
- Typecheck including test support passed:
  `/tmp/agenc-durable-handles-qualification-typecheck.log`. Build, package
  entrypoint and SDK artifact checks passed:
  `/tmp/agenc-durable-handles-qualification-build.log`. The affected hermetic
  suite passed **169 tests in 20 files**, with the runner requiring zero skips:
  `/tmp/agenc-durable-handles-qualification-affected.log`. The included Python
  contract wrapper ran **52 tests**, also passed separately in
  `/tmp/agenc-durable-handles-python-final.log`.
- The fresh disposable Docker probe passed real handle recovery across controller
  connections, stale-handle isolation in a second environment manager, and
  double-fork/setsid residual-cleanup reporting with the original zero leader
  exit code. All prior signal, filesystem, search, environment-death and daemon-
  death cases passed: `/tmp/agenc-durable-handles-qualification-kernel/`. Fixture
  cleanup completed and the outer Docker runtime configuration remained unchanged.
- This is still fixture-controller evidence. Actual AgenC bootstrap, canonical
  settlement and original-session journal survival remain unverified. Restoring
  the manager's original handles/output cursors from checkpoint v5 and rollout v6
  remains required; durable host identifiers do not implement those readers or
  writers. Full hermetic/kernel qualification, Harbor, packaging and all other
  unchecked ledger requirements remain open.

Detached-service integration evidence (2026-09-14 America/Edmonton):

- `AGL3` extends the sealed native task bootstrap with a host-allocated task log
  path and a separate inherited startup channel. The native launcher establishes
  a session, exclusively creates a 0600 append-mode task log, redirects stdout
  and stderr to that file, verifies closed task `/dev/null` stdin and closes all
  private descriptors before executing the exact admitted program/argv/env.
  Existing files/symlinks and invalid layouts execute no target instructions.
  Kernel sender credentials and a bounded descriptor receipt report startup;
  explicit bootstrap errors are separate from task stdio.
- `DetachedExecution` uses Docker's detached start mode and original exec
  inspection. Owner closure and supervisor shutdown do not connect service
  stdout to a closing host pipe. Leader exit retains daemon descendants in the
  original environment scope; cleanup of a completed scope still closes its
  launch fence and proves emptiness. Recovery never repeats create/start/input,
  and a created-but-unclaimed Docker exec cannot become a fabricated zero exit.
- The actual public manager delegates detached launch to the environment. The
  shell tool now passes its trusted owner for this path. Returned PID and log
  path refer to the task; there is no model `session_id`. The existing two-second
  default wait, early failures and cancellation after acknowledged startup are
  preserved. An uncertain launch remains inspectable and is never retried.
  Hosts without `detached_task_logs` reject that launch before dispatch.
- Native filesystem worker protocol 4 adds a private read-only inode export for
  live service logs. Appending content does not invalidate that stream; ordinary
  bound input retains full version validation. Replacement paths cannot change
  the held inode. Restart recovery compares the original device/inode/mode.
- Observed service output is copied to protected host evidence and fsynced before
  cursor/receipt acknowledgement, bounded at 256 MiB. The original task service
  keeps its own log independently. Unsettled retention preserves the bytes and
  refuses to overwrite them; replacing or deleting a task log cannot replace
  acknowledged host output. Terminal completion waits for final-tail retention
  as well as proved scope cleanup. New host output files sync their directory
  entry before dispatch.
- Typecheck including test support passed:
  `/tmp/agenc-detached-qualification-typecheck.log`. Build, package entrypoint
  and SDK checks passed: `/tmp/agenc-detached-qualification-build.log`. The
  affected hermetic run passed **173 tests in 20 files**, requiring zero skips:
  `/tmp/agenc-detached-qualification-affected.log`. Its included Python wrapper
  ran **59 host/native contracts**, also passed separately in
  `/tmp/agenc-detached-qualification-contracts.log`.
- The final package rebuild includes the updated execution-host documentation:
  `/tmp/agenc-detached-package-build.log`; entrypoint and SDK checks passed.
- The fresh probe using both packaged native binaries passed original task-root
  self-kill/subsequent calls and all prior process/filesystem/search cases, plus
  detached native descriptor/stdio checks, service owner closure, graceful and
  SIGKILL supervisor restarts, original-handle/cursor recovery, and survival of
  double-fork/setsid descendants after their leader's zero exit. Start counters
  remained one. Replaced task logs left the host prefix intact and further
  recovery failed explicitly; explicit scope cleanup still succeeded. Evidence:
  `/tmp/agenc-detached-qualification-kernel/`. The fixture was removed and the
  outer Docker runtime configuration remained unchanged.
- These tests use a fixture controller, not an actual AgenC session/canonical
  journal. Session bootstrap, checkpoint v5/rollout v6, full entrypoint coverage,
  installer/fixed LSM policy, Harbor, benchmark recapture and full acceptance
  suites remain required. No container CLI flag has been enabled.

Next integration dependencies: implement checkpoint/rollout-backed manager
restoration of original handles and output cursors without replaying commands or
input. Complete explicit local environment and prepared-spawn
callback replacement; migrate lifecycle services, including browser extra-pipe
transport, without exposing host spawning. Finish general filesystem primitives
and reconcile native snapshot/staging limits with edit/patch limits, then bind
before bootstrap project reads. Migrate all callers, environment-aware caches,
canonical recovery and persistence before enabling isolated sessions. Complete
installer/preflight/LSM and Harbor,
and run the full acceptance gates recorded above.

Checkpoint binding integration (2026-09-14 America/Edmonton):

- New canonical metadata uses rollout schema 6. Checkpoint v5 carries a
  required `executionEnvironment` binding, containing only local identity or
  immutable Docker ID/generation and the supervisor receipt-store namespace.
  Strict parsing rejects selectors, control paths, missing identities and
  unversioned fields; validated bindings are copied and frozen.
- Checkpoints v1–v4 keep their original readers and prefix algorithms. Atomic
  migration validates source evidence before producing v5 with explicit local
  execution for old sessions. A v4 upgrade preserves the v3 prefix digest.
  Re-running migration is idempotent. Conflicting metadata/checkpoint identities
  fail before publication, including conflicts across multiple metadata rows.
- The canonical store compares the requested binding before repairing a resume
  tail. Metadata and checkpoint appends and typed rewrites reject a changed
  identity. Container cwd comparison avoids host path canonicalization at these
  store boundaries. Reconstruction retains the binding; the resume driver
  forwards it and the turn kernel checks it before doing turn work. This does
  not implement environment selection before session bootstrap or all workspace
  reads; E2 and the execution-path migrations remain open.
- Updated current-schema fixtures cover compaction, rollback, atomic upgrades,
  canonical recovery and retention. The initial focused qualification passed
  **435 tests in 12 files**, zero skips:
  `/tmp/agenc-binding-checkpoint-qualification.log`. The expanded run exposed
  old fixtures plus unrelated qualification failures, including sandbox import
  initialization and protected native IPC observation; it did not qualify the
  full hermetic suite (`/tmp/agenc-binding-checkpoint-expanded.log`).
- The hermetic observer now holds a read-only process-memory descriptor opened
  at the kernel exec stop, refreshes it on each exec, and closes it on removal.
  It can inspect syscall arguments after the native launcher disables dumping,
  without changing that launcher protection or granting network exceptions.
  New mandatory canaries prove private descriptor IPC, observation across exec,
  and rejection of public sendmsg destinations while dumping is disabled.
  Combined binding/native qualification passed **500 tests in 19 files**,
  including all **59 Python host contracts**, with zero skips:
  `/tmp/agenc-binding-native-qualification.log`.
- A shared launcher-identity leaf module removes the engine/configuration
  circular initialization that prevented durability crash children from reaching
  failpoints. The rerun reached and passed every durability failure-matrix case.
- Final typecheck including test support passed
  (`/tmp/agenc-binding-checkpoint-typecheck.log`). The final build, package
  entrypoint and generated SDK artifact checks passed
  (`/tmp/agenc-binding-checkpoint-build.log`). The fresh packaged-native kernel
  probe passed all prior process/filesystem/owner/service/restart cases:
  `/tmp/agenc-binding-checkpoint-kernel/` and its sibling `.log`. Its disposable
  fixture was removed; outer Docker runtime configuration remained unchanged.
- The latest expanded hermetic run passed **2,497 tests and failed 3**, across
  165 files, with no skipped tests:
  `/tmp/agenc-binding-checkpoint-expanded-final.log`. All binding, migration,
  compaction/rollback, canonical recovery/retention, host/native contracts and
  durability failure-matrix tests passed. Remaining failures are
  `session/background-extraction-fence.test.ts` (opted-in extraction does not
  sample), `session/lifecycle.test.ts` (extraction child is never called), and
  `session/cost.test.ts` (unknown cost for `ollama-cloud:deepseek-v4.1-flash`).
  These remain qualification work; this run is not a successful full-suite gate.
- Environment process handles and output cursors still require canonical
  checkpoint/recovery integration. No container CLI flag or SDK execution
  selection has been enabled; bindings alone do not establish controller
  survival. Full bootstrap/migration, fixed LSM/installer, Harbor, benchmark
  recapture and end-to-end acceptance remain required.

## Managed handle checkpoint and recovery integration (2026-09-14)

- Revalidated the objective attachment and current worktree. The previous
  workflow-prompt response made no implementation progress; this continuation
  resumed the outstanding P1/R1/R3 integration without changing the goal.
- `unified-exec/process-recovery.ts` defines strict, copied recovery state for
  acknowledged, still-pollable handles. State binds immutable environment,
  receipt-store namespace, owner, authority revision, original operation
  coordinates, numeric handle, process-spec digest, task identity, absolute
  timeout, admission/failure state and last delivered output position.
- `EnvironmentProcessManager` and the public unified-exec manager now expose
  capture/restore operations. Capture rejects active tool calls. Restoration
  requires a fresh manager and validates all original receipts/cursors before
  publishing any handles. It does not invoke launch, write, EOF or resize.
  Pending output is reread from the supervisor, without repeating already
  delivered output. Completed but unpolled handles retain their final output;
  fully consumed terminal handles remain absent. Failed recovery closes local
  admission without replacing or terminating the original operation.
- `recoverable-utf8-decoder.ts` preserves Node decoder behavior with at most
  three carry bytes per stream. A two-byte-prefix exhaustive test covers all
  65,536 prefixes, including invalid UTF-8, restoration after every packet,
  empty packets and EOF. Mixed-stream recovery tests ensure a stdout carry
  need not be adjacent to the aggregate cursor when stderr follows it.
- Checkpoint v5 requires process state for Docker and forbids it for local
  checkpoints. Readers, writers, canonical envelope validators, reconstruction,
  orphaned-turn resume transport and compatibility fixtures were updated.
  The run-turn test exercises both local and Docker manager contracts and
  verifies restoration before sampling and process state in emitted checkpoints.
- The first kernel run exposed an incorrect new client assumption that decoded
  byte counts equal cursor advancement. Docker output files also retain framing
  headers. The client now validates framed and unframed streams separately;
  the original framing fixture remains intact, and manager fixtures now model
  framing offsets. Initial failed evidence:
  `/tmp/agenc-process-recovery-kernel/` and sibling `.log`.
- `managed-recovery-probe.ts` runs in two distinct fixture controller processes.
  The first fsyncs host-owned recovery state and SIGKILLs only itself while its
  task has emitted incomplete Unicode on both streams. A new controller restores
  the original handle, releases the remaining task output through the protected
  filesystem worker, strictly terminates the task and polls its final bytes.
  Read-only host SQLite checks establish exactly one original launch and one
  unchanged acknowledged EOF receipt. Both the corrected and final disposable
  Docker probes passed:
  `/tmp/agenc-process-recovery-kernel-corrected/` and
  `/tmp/agenc-process-recovery-kernel-final/`, with sibling `.log` files.
  This is a real controller crash/restart fixture, not an actual AgenC canonical
  session; V1 remains open.
- Initial focused hermetic qualification passed 321 tests in 12 files, zero
  skips (`/tmp/agenc-process-recovery-integration.log`). The first expanded
  run passed 2,582 tests and failed the same three extraction/cost cases seen
  in the preceding binding turn (`/tmp/agenc-process-recovery-expanded.log`).
  The extraction fixtures were corrected to provide explicit writable parent
  policies; their sampling and shutdown-order assertions were retained.
- Final typecheck including test support passed
  (`/tmp/agenc-process-recovery-typecheck-final.log`). Final build, package
  entrypoint and generated SDK artifact checks passed
  (`/tmp/agenc-process-recovery-build-final.log`). The final expanded hermetic
  run passed **2,591 tests and failed 1**, across **177 files**, with **zero
  skips** (`/tmp/agenc-process-recovery-expanded-final.log`). Both extraction
  tests now pass. All selected process, checkpoint, reconstruction, canonical
  recovery, durability and ownership tests pass. This is still neither the
  complete hermetic suite nor a successful full qualification gate.
- The remaining failure is `session/cost.test.ts`, for the default
  `ollama-cloud:deepseek-v4.1-flash` registry entry. The current official
  [Ollama pricing page](https://ollama.com/pricing), inspected on 2026-09-14,
  lists both regular and weekday peak rates. The current `ModelCostEntry`
  representation has no request-time pricing dimension. No rate was guessed
  and no assertion was skipped; resolving this qualification failure remains
  required. Both final fixture processes are terminal, their disposable Docker
  host was removed, and `git diff --check` passes.
- Full-session bootstrap selection, restoration after later canonical effects,
  recovery of unacknowledged operations, canonical review settlement, read-only
  access through revoked/dead environments, and qualification of checkpoint
  metadata against the canonical line budget at extreme concurrency remain
  open. No container CLI/SDK selection has been enabled. The remaining path
  migrations, installer/LSM/preflight, Harbor, benchmark measurements and full
  acceptance contract still require completion.

## Task configuration filesystem integration (2026-09-14)

- Re-read the active goal attachment and repository instructions after the
  interruption. This continuation advances E2/M2; it does not change the
  completion contract or enable a partially isolated session entrypoint.
- Native filesystem worker protocol 5 adds descriptor-confined path metadata,
  with explicit follow/no-follow symlink behavior. It reuses the existing
  openat2 walker and ordinary-resource checks, exports no descriptors and
  adds no worker syscalls or capabilities. Supervisor and TypeScript client
  negotiate `filesystem_path_metadata` before worker creation. Invalid paths
  and symlink policies fail before client dispatch; ownership and worker epoch
  checks apply on the host.
- `config/workspace-filesystem.ts` binds configuration reads to a copied
  immutable environment identity. Reads hold a native file capability and
  check path/target inode identity before and after reading. Absolute task
  symlinks retain task-root resolution. Ordinary reads retain the chunked
  file-read path rather than inheriting the native transaction snapshot limit.
  Missing files are distinguished from environment loss and other failures.
- Config repository/store accept this explicit filesystem for project/local
  TOML, explicit task `--config` paths, root-marker discovery and metadata-only
  retired project-input detection. Relative explicit paths use the task cwd.
  Global user/managed settings, managed drop-ins and runtime state remain
  controller-owned. Physical-file comparisons include the environment
  namespace; identical path spellings in the controller and task are distinct
  authorities, while same-inode aliases within one task still fail.
- Selected configuration requires an explicit task cwd, rejects the host
  loader override seam and does not consult the host pathname trust ledger.
  An explicit operator trust value remains supported. Discovery uses only an
  explicitly provided task home boundary. The existing local synchronous root
  walk moved to `workspace/project-root.ts` and is re-exported from
  `session/session-store.ts`, removing an unnecessary config-to-journal import
  dependency without changing local behavior.
- New hermetic fixtures cover independent `/app` configurations, host shadows,
  trust separation, absolute symlinks and alias rejection, path replacement,
  environment loss, retired metadata rejection and task-home discovery.
  `execution-host/config-probe.ts` exercises the real repository loader against
  the native worker and an actual task container, including equal host/task
  paths and controller-owned user configuration.
- Initial qualification found fixture errors that expected untrusted project
  model settings to override user settings. Corrected fixtures supply explicit
  trust only for trusted cases and separately assert that untrusted project
  values remain inactive. The settings architecture allowlist now identifies
  the two new negative retired-input fixtures. The shell authority check
  verifies exact wrapper argument quoting rather than requiring the old helper
  name. The remote attribution check follows the canonical protocol allowlist;
  the retired `USER_TYPE` variable is documented as ineffective. Initial
  evidence: `/tmp/agenc-config-environment-hermetic.log` (1,087 passed, 7 failed)
  and `/tmp/agenc-config-environment-kernel/` with sibling `.log`.
- Typecheck including test support passed
  (`/tmp/agenc-config-environment-typecheck.log`); production build, package
  entrypoints and generated SDK artifact checks passed
  (`/tmp/agenc-config-environment-build.log`). The corrected hermetic run passed
  **1,094 tests in 76 files, zero skips**, including all config and execution-host
  tests, session-store compatibility and execution-binding persistence:
  `/tmp/agenc-config-environment-hermetic-corrected.log`. That boundary also runs
  typecheck against its staged sources before Vitest.
- The corrected disposable Docker kernel probe passed the new native metadata
  and real layered-config cases together with all existing process, signal,
  filesystem, service, owner and restart cases:
  `/tmp/agenc-config-environment-kernel-corrected/` with sibling `.log`. This
  remains a fixture controller, not the actual AgenC canonical session required
  by V1. The disposable fixture was removed and the outer Docker runtime
  configuration stayed unchanged.
- Remaining bootstrap dependencies include task cwd canonicalization and
  captured task environment/shell discovery, environment-aware trust and
  workspace cache/editor identities. The secure instruction reader additionally
  requires lossless nlink/nanosecond metadata and canonical path provenance;
  current configuration snapshots retain a lexical resolvedPath and rely on
  lossless inode identity for alias checks. Do not fabricate those instruction
  guarantees from the current metadata interface. All outstanding ledger
  migrations, installer/LSM/preflight, Harbor, benchmarks, pricing qualification
  failure and full-suite acceptance remain open.

## Protected instruction snapshots and path provenance (2026-09-14)

- The preceding goal turn made verified progress on configuration routing;
  this continuation re-read the objective and advances F2/M2/E3 dependencies.
  Full session entrypoints remain disabled until their task paths are migrated.
- Native worker protocol 6 adds `describe_path` and `describe_handle`. Canonical
  paths are accumulated during the existing openat2 component walk and then
  revalidated against the resolved descriptor. Describing a held capability
  additionally verifies that the original pathname still refers to its held
  object. These operations add no syscalls, capabilities, host proc access,
  process execution or worker cwd changes. Existing descriptor reads retain
  their behavior; stale provenance reports a conflict.
- The new description transport sends device/inode/link counts as unsigned
  integers and timestamps as signed seconds plus nanoseconds, reconstructing
  lossless decimal strings in the supervisor. It does not squeeze timestamps
  into signed 64-bit nanoseconds or floating-point milliseconds. TypeScript
  validates and freezes the full identity. Existing compact stat transport is
  unchanged. `bindFileSnapshot` provides protected bounded reads, exact
  descriptor metadata and explicit release.
- Canonical path reconstruction deliberately uses the confined walker rather
  than raw `getcwd`, whose Linux syscall has a
  [PATH_MAX return limit](https://man7.org/linux/man-pages/man3/getcwd.3.html).
  Real Docker evidence covers a canonical task path over 4,096 bytes, within the
  worker's existing path/depth bounds, without widening the syscall allowlist.
- `prompts/instruction-filesystem.ts` separates local descriptor I/O from the
  selected environment. The shared secure instruction reader now uses this
  interface for boundary resolution, no-follow metadata, open/read/stat and
  release. Local O_NOFOLLOW/O_NONBLOCK behavior remains intact. Task reads
  retain single-link, symlink, byte-limit, UTF-8, identity, content and
  revocation checks. Environment/authority loss propagates instead of being
  mistaken for absent guidance. Snapshot provenance carries the binding.
- Exact external-include approvals and their audit records now include the
  environment binding. An approval for equal controller paths or a different
  container generation cannot authorize a task include. Project root discovery,
  singular/chain instruction loading and recursive `resolveIncludes` accept the
  selected environment; descendants retain it. Task discovery never obtains
  its home boundary from the controller.
- Configuration snapshots now use the same exact bound file capability and
  return the protected canonical path. This closes the previous turn's lexical
  `resolvedPath` limitation while preserving absolute task symlinks and the
  controller/task configuration authority split.
- `instruction-probe.ts` exercises production instruction APIs in disposable
  Docker: controller path shadows, full timestamp identity, root/chain and
  recursive include discovery, symlink and hard-link rejection, bounded/invalid
  text, environment-scoped external approvals, revocation before read, parent
  replacement, mutation after open and deep paths. The initial kernel attempt
  failed because an assertion message eagerly JSON-serialized a successful
  BigInt snapshot. The assertion now reports only its failure reason; no
  production guarantee was relaxed. Initial evidence:
  `/tmp/agenc-instruction-environment-kernel/` with sibling `.log`.
- The initial typechecks passed (`/tmp/agenc-instruction-environment-typecheck.log`
  and `...-typecheck-updated.log`). Final production build, package entrypoint
  and generated SDK checks passed:
  `/tmp/agenc-instruction-environment-build-final.log`. The final hermetic
  boundary also typechecks its staged runtime/test-support sources before
  running Vitest, and passed **1,567 tests across 109 files, zero skips**:
  `/tmp/agenc-instruction-environment-hermetic-final.log`. It covers all config,
  execution-host and prompt tests plus session-store and binding persistence.
- Both the corrected and final disposable Docker kernel probes passed all
  existing signal/process/filesystem/service/controller-recovery cases and the
  new instruction cases. Final evidence:
  `/tmp/agenc-instruction-environment-kernel-final/` with sibling `.log`.
  Both fixture handles are terminal and their disposable hosts were removed;
  the outer runtime configuration stayed unchanged. The final run includes
  recursive task includes and protected config canonicalization added after
  the earlier corrected run.
- Next integration work is the tiered loader, bounded rule discovery, cache
  probes and live instruction assembly. `agenc-md.ts` still has local-only
  cache candidate/stat paths and tiered rules; do not pass task paths to those
  production entrypoints until their environment-aware routing is complete.
  Rule discovery needs bounded streaming directory capabilities, not an
  unbounded materialized `readDirectory` result. Full bootstrap, other task
  paths, canonical lifecycle/recovery, installer/LSM/preflight, Harbor,
  benchmark recapture and all acceptance gates remain required.

Tiered instructions, rule cursors and cache evidence (2026-09-14):

- `ExecutionFilesystem.bindDirectorySnapshot` exposes a held directory and a
  single asynchronous cursor. Docker pages contain at most 128 validated
  entries. Early return stops enumeration; capability disposal releases the
  cursor once. Full `readDirectory` uses the same interface. Existing native
  protocol 6 supplies the operations; no worker syscall or authority expansion
  was needed.
- `instruction-filesystem.ts` binds task directories lazily and compares the
  held descriptor's exact metadata with the scanner's original identity before
  enumeration and after completion. Swapping a directory before binding cannot
  supply replacement entries. The reader releases the handle on early resource
  cap rejection and normal/error exits.
- Rule discovery routes canonical paths, metadata, directory enumeration and
  secure file reads through the selected environment. Existing whole-tree
  limits and literal-path/glob matching remain intact. File, directory and rule
  evidence carries the environment binding. Environment/authority failures
  propagate rather than becoming absent rules.
- The tiered loader routes project/local files, project rules, nested includes
  and root discovery through the selected filesystem. Managed/user files and
  rules remain controller-owned. Cache keys include the immutable environment
  binding and task home; each positive/negative path probe retains its own
  namespace. Equal task/controller paths cannot overwrite each other's cache
  evidence. Explicitly selected local backends also receive their cache probes.
  Revocable-approval loads remain uncached.
- The new hermetic tests cover cache separation across container/generation,
  equal controller/task instruction paths, changes to either namespace,
  negative candidate and include invalidation, cached environment loss,
  conditional task rules, cursor single-consumption/release, malformed pages,
  early scan limits and pre-bind directory replacement. The real Docker probe
  exercises tiered loading with controller path shadows, controller managed
  and user authority, local nested includes, conditional rules, rule and
  higher-priority candidate changes, and a 2,500-entry rejected rule tree.
- Initial verification exposed fixture errors: the hermetic fake omitted the
  required receipt-store namespace and metadata method; the conditional-rule
  fixtures put glob syntax in the literal `paths` field. The fixtures now use
  the production binding/metadata contract and correct `paths`/`globs` grammar.
  No production assertion, behavior or gate was weakened. Initial failure logs:
  `/tmp/agenc-tiered-instructions-hermetic.log` and
  `/tmp/agenc-tiered-instructions-kernel.log`.
- Production build, entrypoint and generated SDK checks passed:
  `/tmp/agenc-tiered-instructions-build.log`. The initial standalone typecheck
  passed (`/tmp/agenc-tiered-instructions-typecheck.log`); the corrected hermetic
  boundary typechecked its current staged runtime/test-support sources and
  passed **1,574 tests across 110 files, zero skips**:
  `/tmp/agenc-tiered-instructions-hermetic-corrected.log`.
- The corrected full disposable Docker kernel probe passed, including existing
  signal, filesystem, service, strict cleanup and fixture-controller recovery
  checks plus the new tiered instruction checks. Evidence:
  `/tmp/agenc-tiered-instructions-kernel-corrected/` and sibling `.log`.
  Both validation handles are terminal. Disposable hosts were removed and the
  runner verified the outer Docker runtime configuration stayed unchanged.
- Live assembly is the next dependency, not a delivered isolated session:
  `prompts/live-instructions.ts` still calls the loader without a selected
  environment. Its persona loader performs host workspace reads, its prompt
  head uses only cwd, and instruction provenance lacks binding. Persistent
  memory indexes are controller-owned, but `memory/paths.ts:getAutoMemBase`
  currently calls the host `findCanonicalGitRoot(getProjectRoot())`; this must
  be replaced with bound task root evidence before live isolated assembly is
  enabled. Session services/bootstrap must establish and inherit this authority
  before these consumers run. All other unchecked ledger requirements remain
  part of the same acceptance contract.

Live prompt and memory workspace authority (2026-09-14):

- `execution/workspace.ts` resolves regular Git directories, validated worktree
  pointers/backlinks and bare repositories through protected metadata and file
  descriptors. It runs no task Git program. Configuration publication now
  includes the resulting immutable execution workspace; prepared authority,
  commit and rollback retain the matching metadata. Reading a selected
  workspace before configuration bootstrap finishes fails explicitly.
- `ExecutionConfigFilesystem` exposes its immutable environment projection to
  the owning ConfigStore. The canonical settings authority carries the prepared
  workspace, avoiding a second, independently selectable prompt environment.
  `resolveLiveInstructionEnvelope` binds the owning session's configuration to
  its async chain and checks it against the process manager binding before
  discovery. A foreign ambient authority cannot supply its memory indexes.
- The live envelope routes tiered instructions, persona and additional CLI
  directories through the selected filesystem. Persona retains complete raw
  bytes for dedup, its existing 16-KiB prompt truncation and the task-local
  identity/one-time-bootstrap gate. Task directories must be absolute.
  Dedup separates controller guidance paths from equal task persona paths.
  The instruction head key includes environment identity, and content-free
  source provenance carries an optional validated binding through canonical
  event/rollout schema readers. Older local provenance remains accepted.
- Project-memory keys use the protected canonical task root plus immutable
  environment identity without calling host realpath/Git discovery on task
  paths. Prompt, recall's shared path builder and extraction-directory
  resolution use this key. Global/user memory stays in controller storage.
  Local storage naming is unchanged. Broader memory-tool/attachment authority
  and child/bootstrap integration still require migration.
- `memory/entrypoint-text.ts` contains the existing pure index truncation
  implementation; `memdir.ts` re-exports its API. Live assembly imports the
  defining path/text/sanitizer modules without importing the memory barrel's
  tool graph. The import architecture check explicitly allows this authority
  boundary and the already-existing permission path validator exception.
- New hermetic tests cover controller shadows, task persona bytes and gating,
  source schema acceptance/rejection, process/config mismatch, foreign ambient
  authority, `/app` memory/head separation, additional-directory selection,
  validated regular/bare worktree roots and transactional config rollback.
  The Docker probe now calls the production live resolver with real protected
  files and a selected unified manager. It proves task guidance/persona,
  controller index reads, extraction-path agreement and durable provenance.
  Session/provider execution is still a fixture; V1 remains open.
- Verification caught declaration imports left behind by the pure-helper move
  and a fixture manager import name; both were corrected. The expanded probe
  also needed Node `createRequire` interoperability for bundled CommonJS
  runtime dependencies. No filesystem, isolation or process guard was relaxed.
  Initial logs: `/tmp/agenc-live-environment-build.log`,
  `/tmp/agenc-live-controller-probe-build.log`, and
  `/tmp/agenc-live-environment-kernel.log`.
- The first expanded hermetic run exposed mismatched test authorities and
  pre-existing memory-history fixtures that expected writable extraction while
  using `mkCtx`'s read-only default. The source gate and those fixtures were
  unchanged from HEAD before this turn. Resume fixtures now bind configuration
  and execution together; history fixtures explicitly grant their private
  memory directory. Two cron checks also raced real filesystem completion
  using a fixed number of event-loop spins. They now await dispatch before
  asserting exactly-once/non-overlap behavior; scheduler implementation and
  assertions are unchanged. Failure evidence is retained in
  `/tmp/agenc-live-environment-hermetic.log` and
  `/tmp/agenc-live-environment-hermetic-corrected.log`.
- Final production build, package entrypoints and SDK declaration checks
  passed: `/tmp/agenc-live-environment-build-final.log`. Earlier standalone
  typechecks passed (`/tmp/agenc-live-environment-typecheck.log` and
  `...-typecheck-updated.log`); the final hermetic boundary typechecked its
  current staged runtime/test-support sources and passed **2,006 tests across
  141 files, zero skips**: `/tmp/agenc-live-environment-hermetic-final.log`.
- Corrected and final disposable Docker probes passed all existing process,
  signal, worker, mutation, service and fixture-controller recovery cases plus
  the live envelope checks. Final evidence:
  `/tmp/agenc-live-environment-kernel-final/` and sibling `.log`. Handles are
  terminal, fixtures were removed and the outer Docker runtime configuration
  stayed unchanged. These results do not replace full final qualification.
- Next: migrate skills and role discovery/cache authority and then inject the
  binding at operator bootstrap. `skills/local-loader.ts` still uses host
  stat/realpath/readdir/readFile and host watchers; role workspace identity is
  cwd-only, and `agents/role.ts:loadRoleLayerToml` rereads files synchronously.
  Preserve controller user/managed/bundled sources while moving task-controlled
  sources and executables. The remaining E1/E2, M1–M3, R1/R2, installer/LSM,
  Harbor, ingress coverage, benchmark and qualification requirements remain
  mandatory; the full goal is not complete.

Protected plugin package discovery (2026-09-14 America/Edmonton):

- `execution/content-filesystem.ts` provides explicitly selected content
  stat/realpath, text reads and directory enumeration for plugin/skill consumers.
  Task reads use native held capabilities, compare exact descriptor metadata and
  canonical paths before and after I/O, preserve raw UTF-8 text, and dispose the
  capability on every path. A simultaneous read/release failure retains both
  errors. Task paths must be absolute; authority, transport, stale-capability and
  environment failures propagate. No task programs execute in this reader.
- `plugins/loader.ts`, asynchronous `plugins/manifest.ts` and
  `plugins/package-authority.ts` now route task package/root discovery, Git-root
  probes, manifest/install-metadata reads, component enumeration and retired-file
  checks through this authority. JSON keeps its 1-MiB limit. Existing controller
  package installation and synchronous controller manifest readers stay local.
- `PluginLoaderOptions.executionEnvironment` is explicit. Workspace and configured
  paths use the selected filesystem; operator-installed storage uses controller
  authority. A Docker path spelling an installed controller path remains task
  content and cannot register hooks, MCP/LSP, apps or settings. Task package names
  cannot initiate controller plugin-data migrations; operator-installed migration
  remains functional. Bootstrap has not enabled isolated plugin registration yet.
- Package and skill-root results carry immutable environment binding. Root and
  diagnostic dedup separates equal controller/task paths. Dependency evaluation
  keys loaded plugin objects and reports demoted canonical IDs, avoiding the old
  source-path collision that could demote a controller package together with a
  different task package. Duplicate canonical plugin IDs still disable all copies.
- New hermetic tests cover two independent `/app` catalogs, equal host/task
  package and skill paths, dependency ownership, configured controller-lookalike
  paths, retired inputs, JSON limits, exact text, pre-read special-resource denial,
  descriptor acquisition races, authority loss at multiple discovery stages,
  combined read/release failure and controller data migration authority. The
  shared TaskFiles fixture now reports actual entry kinds and root child names.
- Production build/package entrypoint/SDK declaration checks passed:
  `/tmp/agenc-plugin-environment-build-final.log`. Standalone
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH npm run typecheck` passed, including
  test-support types: `/tmp/agenc-plugin-environment-typecheck-final.log`.
  `git diff --check` passed. The hermetic boundary
  typechecked staged runtime and test-support sources and passed **1,477 tests
  across 109 files, zero skips**:
  `/tmp/agenc-plugin-environment-hermetic-final.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/plugins tests/skills tests/execution-host tests/config --reporter=dot`.
- Earlier checks caught the TypeScript overload inference for local bigint stat
  and an invalid test agent path lacking the required `.md` extension. Both were
  corrected; failures remain in `/tmp/agenc-plugin-environment-typecheck.log`
  and `/tmp/agenc-plugin-environment-hermetic.log`. No production permission or
  manifest validation was weakened.
- The disposable Docker kernel fixture passed existing signal/process/worker/
  mutation/recovery cases plus production plugin loading, controller shadows,
  equal-path skill-root separation, legitimate absolute manifest symlinks,
  special-resource rejection, parent swaps and dependency isolation. Evidence:
  `/tmp/agenc-plugin-environment-kernel/` and sibling `.log`. This run preceded
  the final controller-data migration filter, which the final hermetic run covers;
  the kernel case uses read-only plugin inventory. Fixture handles are terminal
  and containers were removed. This remains a fixture controller, not V1's full
  AgenC canonical-run reproduction or final qualification.
- Next: pass source bindings through `skills/local-loader.ts` and plugin
  registration consumers. `plugins/registration/common.ts` still has host
  markdown/scan helpers, a path-only runtime identity and a cached loader that
  does not forward the selected environment. Command/skill/agent/output-style
  registration and render-time rereads must be migrated together. Skill watcher
  paths must not enter the controller FileWatcher; preserve hot reload and hook
  mediation through the selected environment. `bin/bootstrap-services.ts`,
  `commands.ts` and `app-server-client/index.ts` construct skill services and
  still need binding injection. Roles, the remaining execution entrypoints,
  canonical recovery, installer/LSM, Harbor, coverage and full qualification
  remain mandatory. The full acceptance contract is still open.

Protected plugin registration (2026-09-14 America/Edmonton):

- `plugins/registration/common.ts` captures explicit or owning canonical
  workspace environment authority and forwards it to package discovery. Task
  cwd selectors must be absolute. Before registration, supplied loaded-plugin
  records are checked against the selected immutable binding; missing workspace
  provenance, foreign generations and task records claiming controller authority
  fail explicitly. Operator-installed packages retain controller content reads.
- Command/skill/agent/output-style markdown and directory scans now use
  `ContentFilesystem`, including the direct skill-directory API. No registration
  helper directly imports host filesystem operations. Command and skill render
  closures retain their selected reader and check task liveness before rendering.
  Command metadata, slash-command projection and plugin-agent definitions carry
  optional execution binding. The existing repository guidance restrictions on
  executable fields, settings, servers and output-style activation remain.
- Registration cache identity includes the selected environment. Active command,
  skill and agent snapshots retain discovery configuration; selected task sources
  reload through the protected filesystem instead of returning stale content or
  masking environment death. Local snapshot behavior remains available. Refresh
  passes the owning session's bound environment and stores complete discovery
  options. Main command/local-skill/role catalog caches still need migration.
- All registration families validate supplied source bindings, including hooks,
  MCP, LSP and output styles before filtering task-controlled sources. Their
  eventual process launches, controller-installed helper staging, explicit task
  environment variables and external-integration credential handling remain M3
  work; this content migration does not establish those execution guarantees.
- A task `${AGENC_PLUGIN_DATA}` template currently raises `unsupported_resource`
  before creating a controller directory. **Task plugin data compatibility remains
  unfinished**: provide an environment-owned data directory with mediated creation
  and durable mutation behavior, then replace this refusal. Do not restore host
  mkdir as a fallback or count refusal as delivery of the data feature. Controller
  data behavior remains covered by existing plugin registration tests.
- New hermetic tests cover mixed controller/task packages at equal paths,
  rendering and direct skill loading, agent binding and restricted fields,
  all registration families rejecting foreign/missing/stale authority, separate
  `/app` active snapshots, retained discovery settings, protected refresh,
  canonical ConfigStore environment inference, environment death and task-template
  refusal without controller directory creation.
- Production build, entrypoint and SDK declarations passed:
  `/tmp/agenc-plugin-registration-build.log`. Standalone typecheck including
  test-support passed: `/tmp/agenc-plugin-registration-typecheck-corrected.log`.
  Its initial run caught an import from the wrong module, corrected before the
  build. The hermetic boundary typechecked staged sources and passed **2,274
  tests across 170 files, zero skips**:
  `/tmp/agenc-plugin-registration-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/plugins tests/skills tests/execution-host tests/config tests/commands --reporter=dot`.
- The Docker probe now executes production plugin registration and rendering
  against the native worker, retaining existing symlink, race, signal, service
  and recovery checks. First execution exposed a fixture packaging omission:
  the slash parser loads `shell-quote` through createRequire, outside esbuild's
  static graph. The fixture now stages a bundle of the actual locked dependency;
  production code and guards were not bypassed. Failure evidence:
  `/tmp/agenc-plugin-registration-kernel/` and sibling `.log`.
- Corrected disposable kernel qualification passed:
  `/tmp/agenc-plugin-registration-kernel-corrected/` and sibling `.log`.
  The process is terminal, disposable containers were removed and outer runtime
  configuration stayed unchanged. `git diff --check` passed. This is still a
  fixture controller; V1's actual AgenC canonical run and full final qualification
  remain open.
- Next: migrate `skills/local-loader.ts`, its watcher/change detector, the
  `commands.ts` local-skill service cache and bootstrap/app-server-client service
  constructors. Preserve per-source controller/task authority and skill limits,
  conditional activation, dynamic discovery and hot reload. Then complete role
  workspace identity and synchronous role-content consumers before enabling
  operator bootstrap selection. All other ledger requirements remain mandatory.

Protected local skills and reload (2026-09-14 America/Edmonton):

- `skills/local-loader.ts` no longer imports host filesystem operations. Each
  source supplies `ContentFilesystem`: project, dynamic and task plugin roots
  carry the selected immutable environment; operator user/managed/bundled roots
  retain controller authority. Task HOME governs task ancestor traversal and is
  distinct from the controller HOME. Equal task/controller paths and canonical
  paths remain distinct during source and file deduplication.
- Directory scanning, direct-root skills, conditional activation, rendering,
  fresh selected snapshots, dynamic discovery and truncation accounting use the
  bound reader. Environment death and revoked authority propagate through skill
  loading and command discovery. Invoked-skill records include environment and
  generation as well as session/agent identity. Local command service cache keys
  include environment identity and no longer parse paths from composite keys.
  Projected commands retain their source binding.
- Bootstrap and daemon-client skill constructors forward their ConfigStore's
  existing workspace environment/home; the bootstrap constructor also supplies
  conversation ownership. This is **not** operator executionTarget bootstrap:
  binding must still be resolved before all project reads, roles and launchers.
- `skills/execution-watcher.ts` polls protected metadata and held directory
  enumerations for task roots; only controller paths enter the OS FileWatcher.
  It detects creation/replacement/deletion and newly discovered roots, retries
  conflicted enumerations without publishing partial snapshots, and retains
  environment failure. Tree/directory enumeration has a million-entry bound.
  Subscription initialization is shared; stop fences and awaits pending setup
  and closure. Old callbacks and reload completion cannot publish after disposal.
  Background error-reporting failures are retained rather than left as unhandled
  rejections. Existing local watcher behavior remains covered.
- **Open compatibility dependencies:** selected config-change hooks require an
  explicit environment hook runner. Until M3 supplies it, default selected watch
  startup raises `unsupported_resource`; disabling hooks or supplying the runner
  exercises protected reload. This refusal is not full hook implementation.
  Bundled/operator helper staging, task plugin data creation, remaining skill
  consumers outside this service and complete execution-path coverage remain
  mandatory. Do not enable isolated bootstrap by bypassing these requirements.
- New hermetic cases cover same-path authority, conditional activation, task
  HOME, refreshed content, exact dropped counts, task loss/revocation, command
  discovery from ConfigStore, invocation ownership, protected change events,
  parent-swap retry, pending initialization/disposal, stale callbacks, hook
  failure and throwing error reporters.
- Production build, entrypoints and generated SDK declarations passed:
  `/tmp/agenc-skills-boundary-build-final.log`. Initial standalone typecheck:
  `/tmp/agenc-skills-boundary-typecheck.log`. The hermetic runner also typechecked
  staged sources and passed **2,286 tests / 172 files / zero skips**:
  `/tmp/agenc-skills-boundary-hermetic.log`. The selected scopes were skills,
  execution-host, plugins, config and commands. An additional supplied test
  selector did not name an existing file; the actual constructor checks were
  then run explicitly against `tests/bin/bootstrap-services.test.ts` and
  `tests/app-server-client/index.test.ts`: **44 tests / 2 files / zero skips**,
  `/tmp/agenc-skills-constructors-hermetic.log`.
- Kernel qualification passed in
  `/tmp/agenc-skills-boundary-kernel-split/` and its sibling `.log`. Production
  skill loading/rendering and hot reload run against the real native worker:
  task shell/file view, host shadow exclusion, absolute symlink deduplication,
  fresh reads and protected creation events pass. All existing process, native
  filesystem, broad-signal, descendant, detached-service and recovery probes
  also pass. This remains a fixture controller, not V1's full AgenC canonical run.
- Earlier kernel attempts failed in fixture packaging, retained at
  `/tmp/agenc-skills-boundary-kernel/` and
  `/tmp/agenc-skills-boundary-kernel-corrected/` with sibling logs. The fixture
  builder now uses production feature transforms, aliases, text loaders and ESM
  splitting without invoking the asset plugin or changing dist. Installed
  dependencies resolve with their real import conditions; absent optional
  integrations follow production externalization. Locked shell-quote is still
  staged for createRequire. No production behavior or test assertion was mocked
  out to resolve packaging. Final fixture processes are terminal, disposable
  containers removed, and the outer Docker runtime configuration unchanged.
- Next: migrate `agents/role-workspace.ts`, `agents/role.ts` and
  `tools/AgentTool/loadAgentsDir.ts`. Role workspace identity is still cwd-only;
  role config and definition readers still use synchronous host filesystem APIs.
  Capture protected role content asynchronously and retain pure synchronous
  consumers only where their input is already bound, preserving freshness and
  fingerprints. Then finish operator bootstrap and all remaining ledger entries.
  Full acceptance remains open; this milestone does not close E2/M2/M3 or V1.
- Final lifecycle review found that a rejected subscription provider could retain
  its callback before the next restart. Initialization failure now immediately
  revokes that lifecycle, preventing such events from scheduling a reload with
  cleared options. The regression test emits during this precise failure window.
  Rebuilt production/entrypoints/SDK checks passed:
  `/tmp/agenc-skills-lifecycle-build.log`; standalone typecheck and test-support
  checks passed: `/tmp/agenc-skills-lifecycle-typecheck.log`. The complete
  disposable kernel probe passed again against this source state:
  `/tmp/agenc-skills-lifecycle-kernel/` and sibling `.log`. Fixture processes are
  terminal and removed; `git diff --check` remains clean.
- Final affected hermetic rerun passed **1,064 tests / 87 files / zero skips**,
  including the added failed-setup callback assertion, all skills/execution-host
  and command tests, and both modified service constructors:
  `/tmp/agenc-skills-lifecycle-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/skills tests/execution-host tests/commands tests/bin/bootstrap-services.test.ts tests/app-server-client/index.test.ts --reporter=dot`.
  No build or test handles remain live from this milestone. No commits were made.

Protected role content and workspace identity (verified milestone, 2026-09-14):

- `execution/markdown-content.ts` discovers task Markdown tiers through protected
  metadata, validating Git directories/pointers and bare repositories, preserving
  nested-repository traversal and sparse worktree fallback. It enumerates without
  running ripgrep, rejects symlinks/hard links/special files, bounds the tree, and
  checks directory chains and held file identities across reads.
- The shared Markdown loader selects this path for task project tiers, retains
  controller user/managed tiers, propagates bindings and separates identity dedup.
  Selected loads bypass stale caches. Agent definition loading retains protected
  source provenance instead of reopening task paths through synchronous host
  checks. Missing/foreign bindings and revoked/dead authority fail explicitly.
- Role workspace identity now optionally carries the full immutable execution
  binding; Docker IDs include it, while legacy local IDs remain the canonical
  cwd. Definition/catalog validation checks both workspace and source binding.
  Bootstrap and Session defaults forward their existing ConfigStore binding.
- Programmatic task TOML roles are captured asynchronously with protected reads
  before catalog creation. Captured role/definition associations are controller
  WeakMap entries, retained across in-process session array copies. Synchronous
  role resolution uses captured TOML; attempting to resolve uncaptured task file
  content fails before host I/O. Fresh discovery creates fresh fingerprints while
  already-created catalogs retain their original content and fingerprint.
- Remaining role integration includes daemon/SDK/recovered workspace transport,
  TUI and other workspace constructors, and task agent-memory reads/mutations.
  Agent memory with project/local scope currently raises `environment_not_ready`
  when selected, preventing its synchronous host readers from opening task paths.
  **This guard is a temporary gap, not delivery of memory compatibility.** User
  memory remains controller-owned. E2, all M2/M3 caller coverage and other original
  requirements remain open.
- New role hermetic cases cover mixed equal paths, fresh content, task loss and
  revocation, generation-scoped role registration, foreign/missing provenance,
  captured TOML and fingerprints, unsafe files, parent swaps, nested repositories,
  valid/invalid Git markers, bare repositories and sparse worktrees.
- Build/entrypoints/SDK checks passed:
  `/tmp/agenc-role-environment-build-corrected.log`. Earlier standalone typechecks
  passed: `/tmp/agenc-role-content-typecheck.log` and
  `/tmp/agenc-role-binding-typecheck.log`. Final standalone production and
  test-support typechecks also passed: `/tmp/agenc-role-environment-typecheck-final.log`.
- Real kernel role qualification passed:
  `/tmp/agenc-role-environment-kernel-corrected/` and sibling `.log`, including
  all previous process/filesystem/skills/recovery probes. Initial kernel attempts
  (`...-kernel`, `...-kernel-diagnostic`, `...-kernel-layers`) localized absent role
  names to fixture packaging: production YAML parsing dynamically requires
  `js-yaml`, which had not been staged. The fixture now bundles the locked package
  alongside shell-quote; production parsing and assertions were preserved.
- The broad hermetic selection passes **2,128 assertions / 148 files**, but the
  runner exits **97** because Git processes attempt DNS; it is **not qualified**.
  Logs: `/tmp/agenc-role-environment-hermetic-trace.log` and
  `/tmp/agenc-role-git-operation-broad.log`. Its earlier assertion failure was a
  stale `run-agent.inject-child-args.test.ts` expectation: HEAD already supplies
  cwd for FileRead/Write/Edit/MultiEdit/Glob/Grep, while the test expected only
  shell/patch tools. The test now checks the existing broader behavior, explicit
  cwd preservation and no cwd for process listing; production was not relaxed.
- Diagnostic isolation: `tests/agents/run-agent.test.ts` alone passes **151 tests**
  without any network violation (`/tmp/agenc-role-git-operation-diagnostic.log`).
  The test boundary now adds only fixed, allowlisted Git operation labels to
  violation logs; no arbitrary argv is emitted and no enforcement is changed.
  A focused worktree-removal boundary run is being observed to locate the DNS
  source. Temporary GIT_TRACE test edits were removed. Do not discard the broad
  runner rejection or call the passing assertion count successful qualification.

- Final hermetic qualification for this milestone passed: **2,129 tests / 148
  files, zero skips, exit 0**, `/tmp/agenc-role-environment-hermetic-final.log`.
  Command: `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/agents tests/tools/AgentTool tests/execution-host tests/config tests/utils/markdown-config-loader-authority.test.ts tests/bin/bootstrap.test.ts tests/bin/bootstrap-services.test.ts tests/app-server-client/index.test.ts tests/session/execution-binding-persistence.test.ts --reporter=dot`.
  The DNS violation was isolated to `worktree-removal-boundary.test.ts`: its
  initial commit supplied identity only for that invocation, while production
  Git deliberately strips ambient identity. Persisting local fixture Git identity
  prevented later Git commands from inferring email through DNS. Focused corrected
  run: 8 tests / 1 file, exit 0, `/tmp/agenc-role-git-worktree-corrected.log`.
  Enforcement and production environment scrubbing remain unchanged.
  The additional selected task-memory regression test is included in 2,129.
  Session 20398 was polled to terminal exit 0; no handles remain live from this
  milestone. Full-plan qualification remains open. Next: preserve role binding
  across daemon/SDK attachment and recovered source metadata, then migrate the
  remaining consumers and actual task agent-memory access.

Role workspace transport and consumer migration (verified milestone, 2026-09-14):

- Shared role-workspace metadata parsing now validates the full binding and a
  separate cwd. Container metadata cannot fall back to interpreting its ID as
  a path. Present malformed/incomplete provenance rejects; older local ID-only
  metadata preserves its existing meaning. Serialized bindings contain no
  backend connection, credentials or execution authority.
- Daemon session summaries and recovered thread-source metadata preserve this
  identity. Stored-thread listing now publishes the same roleWorkspace as later
  attachment. Agent attachment validates summary and metadata provenance together
  and rejects contradictory generations. The protocol and generated SDK wire
  declarations carry the optional immutable binding.
- In-process child configuration records bound role cwd and binding in its spawn
  source. Registered role definitions can take a complete workspace, and Session
  role projection uses that workspace rather than reconstructing a local ID.
  AgentControl and model-facing tool fallback use existing owning-session
  authority. Teammate validation derives binding from the parent; current host
  panes remain unsupported for container sessions until their launcher migrates.
- TUI initial role discovery and refresh preserve the binding. Refresh binds the
  owning ConfigStore explicitly. App state is keyed by conversation and complete
  role workspace identity so replacing a session with another generation at the
  same `/app` cannot reuse the previous role state. Bridge types retain binding.
- Build and SDK wire parity passed (`/tmp/agenc-role-transport-build.log`), and
  corrected typecheck passed (`/tmp/agenc-role-transport-typecheck-corrected.log`).
  The initial typecheck caught branded role-workspace objects crossing a JSON
  index signature; summaries now explicitly project serializable fields.
- First affected hermetic run passed **1,365 tests / 83 files, zero skips, exit
  0**, `/tmp/agenc-role-transport-hermetic.log`. This includes actual FileThreadStore
  persistence/recovery, attach conflicts, real child Session configuration/catalog
  inheritance, role registration isolation, teammate checks and TUI first render.
- The complete existing kernel probe passed, exit 0, with logs in
  `/tmp/agenc-role-transport-kernel/` and sibling `.log`. The role-content probe
  and all earlier process/filesystem/recovery probes passed. Disposable containers
  were removed; outer daemon configuration was unchanged. This does not close
  V1 (actual isolated AgenC session plus canonical journal), E2 or full-plan gates.
- Review then added the TUI same-cwd generation-switch regression. Final build
  and typecheck passed: `/tmp/agenc-role-transport-build-final.log` and
  `/tmp/agenc-role-transport-typecheck-final.log`. The affected selection with
  this additional test passed **1,366 tests / 83 files, zero skips, exit 0**:
  `/tmp/agenc-role-transport-hermetic-final.log`. Session 2435 is terminal.

Remaining integration dependencies identified by this audit:

- `app-server-client/index.ts` can now carry role provenance but its daemon-only
  context constructor still lacks a protected content capability. Review added an
  explicit `environment_not_ready` rejection for container role workspaces before
  constructing/reloading local ConfigStore; metadata can no longer enable host
  reads of task cwd. This is a temporary incomplete attachment path, not delivery.
  E2 must bind a protected backend before those reads or supply daemon-mediated
  content. Wire provenance alone grants neither. Execution-target capability
  negotiation and operator bootstrap remain open. A regression checks rejection
  before ConfigStore.reload; its final build, typecheck and affected tests passed
  as recorded below.
- Actual task agent-memory migration must cover `agentMemory.ts`,
  `agentMemorySnapshot.ts` snapshot/sync mutations, plugin-agent prompt loading,
  the memory command, and permission checks in `utils/permissions/filesystem.ts`.
  The temporary guard in `loadAgentsDir.ts` does not cover the plugin prompt's
  direct `loadAgentMemoryPrompt` call. Shared async protected memory handling is
  required across both rather than relying on that temporary guard.
- User/controller and explicitly configured remote memory need explicit source
  authority, environment-aware project namespaces, and task-visible access where
  tools are expected to edit memory. Existing task-memory synchronous host path
  checks, migrations, background mkdir and filesystem permission exemptions are
  not compatible with the target architecture.
- Remaining editor/workbench persistent keys, all task-facing execution/mutation
  callers, production installer/AppArmor, Harbor and full acceptance qualification
  remain open. No complete-plan claim or commit has been made.

Final role-transport verification and continuation:

- Latest production build/entrypoints/SDK checks: **passed**, exit 0,
  `/tmp/agenc-role-transport-attachment-build.log`.
- Latest production and test-support typecheck: **passed**, exit 0,
  `/tmp/agenc-role-transport-attachment-typecheck.log`.
- Latest affected hermetic selection: **1,367 tests / 83 files, zero skips,
  exit 0**, `/tmp/agenc-role-transport-attachment-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/agents tests/tools/AgentTool tests/execution-host tests/app-server/session-lifecycle.contract.test.ts tests/app-server/agent-cli.contract.test.ts tests/app-server-client/index.test.ts tests/tui/components/App.render.test.tsx tests/tui/components/App.local-agents.test.tsx tests/session/lifecycle.test.ts --reporter=dot`.
- Kernel evidence for the transport/role changes remains
  `/tmp/agenc-role-transport-kernel/` and sibling `.log`, exit 0. Later changes
  were the TUI state generation key and rejection of unbound container TUI
  attachment, covered by the final hermetic regressions. No kernel code changed.
- `git diff --check` passed. All build/typecheck/test handles from this milestone
  were polled terminal, including latest hermetic session 9966. No task fixtures
  remain and no commits were made.
- This continuation made concrete implementation and verification progress; no
  blocker was encountered. The full goal remains active and the original
  acceptance contract remains unmet. Next work should migrate actual task agent
  memory and its permission/snapshot consumers, then complete daemon/operator
  backend bootstrap and the remaining execution/filesystem caller inventory.
  Do not treat the temporary container attachment or memory guards as delivery.

Agent-memory migration prerequisite: protected directory creation (2026-09-14):

- Re-read the objective and repository instructions. The previous role transport
  continuation was implementation/verification progress. No blocker exists.
- Agent-memory audit confirmed both synchronous prompt loaders can read/mutate
  task paths, and `agentMemorySnapshot.ts` performs directory migration, mkdir,
  writes and deletes. Current protected filesystem lacked mkdir. These mutations
  also occur during discovery, before an admitted tool call; moving them to the
  backend without addressing admission would fail or invent startup authority.
  Memory migration remains open, including user/remote source authority, actual
  task-visible memory editing, protected permissions and snapshot/sync behavior.
- Added `ExecutionFilesystem.createDirectory(parentDescription, name, mode)` and
  a Docker implementation. It validates exact parent description through a held
  directory before the admitted RPC, rejects unsafe basenames/modes and older
  hosts before dispatch, and uses existing closed-call/cancellation/effect-index
  boundaries. Capability cleanup retains original errors. No host mkdir fallback.
- Native worker protocol 7 adds operation 26, exclusive descriptor-bound mkdirat.
  It validates the held parent before and after creation, never follows an
  occupied leaf, fsyncs the parent and preserves mutation-start evidence.
  Only mkdirat was added to its syscall allowlist; execution/signal authority
  remains absent. The worker's existing 0022 umask applies; private 0700 is tested.
- Supervisor advertises `filesystem_create_directory` and persists the new
  operation using the existing durable filesystem effect contract. Duplicate
  operation coordinates reject before repeating the syscall. Worker readiness
  version, Python protocol, adapter and host documentation changed together.
- Build/entrypoints/SDK checks passed: `/tmp/agenc-memory-directory-build.log`.
  Typecheck (production + test-support) passed:
  `/tmp/agenc-memory-directory-typecheck.log`.
- Real Docker kernel probe passed, exit 0:
  `/tmp/agenc-memory-directory-kernel/` and sibling `.log`. Added checks cover
  private mode, missing admission, original successful receipt, duplicate-call
  rejection without a second directory, existing directory and symlink refusal,
  and a deterministic parent swap after the controller's validation but before
  native mutation. Both replacement target and moved original parent remain
  unmodified on that precondition failure. Existing complete probe also passed.
- First affected hermetic selection passed **1,080 tests / 82 files, zero skips,
  exit 0**: `/tmp/agenc-memory-directory-hermetic.log`. Tests cover admission,
  pre-dispatch stale parent, invalid names/modes, capability release, unavailable
  host feature and retained unknown acknowledgement without retry.
  Test review then gave independent attempted operations distinct canonical call
  identities; final same-selection rerun passed **1,080 tests / 82 files, zero
  skips, exit 0**, `/tmp/agenc-memory-directory-hermetic-final.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/config tests/tools/AgentTool/agentMemory.workspace.test.ts --reporter=dot`.
  All handles from this prerequisite milestone are terminal, including final
  hermetic session 60226. `git diff --check` passed; no task fixtures remain and
  no commits were made. The full goal remains active and unblocked.
- This is a verified underlying primitive, not completed agent-memory migration.
  F2 still needs remaining primitives/limits and caller integration. Next steps:
  migrate protected memory path/read/snapshot operations with explicit source
  authority, preserve legacy directory adoption and private file modes, and
  establish admitted mutation timing rather than implicit bootstrap side effects.

Protected agent-memory prompt capture (2026-09-14):

- Re-read the objective and repository instructions. The prior directory-creation
  milestone was verified implementation progress; the complete goal stays active.
- `execution/scoped-content.ts` reads a private regular file below an explicit
  task trust anchor using protected descriptions and a held file capability. It
  rejects leaf links, multiply linked files, special resources, escaped parents
  and changes across the read. Safe intermediate absolute symlinks contained in
  the anchor are allowed; their lexical and resolved identities are rechecked.
  The memory directory itself remains nonsymlinked, preserving existing policy.
- `agentMemory.ts` adds asynchronous read/capture entrypoints. Task project/local
  memory is read from the selected filesystem before publishing synchronous
  catalog getters. The prompt is captured once per catalog; fresh discovery
  captures new content while older catalogs retain their prompt. Safe legacy
  MEMORY.md content can be read without performing an unadmitted directory rename.
  Discovery does not mkdir or mutate task memory. Actual legacy directory adoption
  and other mutations remain pending, not silently claimed as implemented.
- The shared synchronous memory API now rejects task scopes before host I/O.
  This replaces the narrower guard previously only in loadAgentsDir. Both custom
  agent discovery and operator-plugin registration capture selected task memory
  asynchronously; repository-controlled roles still cannot grant memory authority.
- User memory and explicitly configured remote memory retain controller source
  authority. Remote project namespaces use the captured environment/generation and
  protected canonical project root, avoiding synchronous host Git-root discovery
  for task cwd. Explicit mismatched remote-memory environment input rejects.
  Task-visible editing of these controller-owned sources is still unimplemented.
- Snapshot discovery now checks the task snapshot path with protected reads.
  Missing task snapshots cannot be replaced by equal host paths. Existing selected
  snapshots currently fail explicitly with `environment_not_ready`; full schema,
  legacy adoption, update/initialization and mutation handling are pending.
  Selected initialize/replace/mark operations reject before modifying even user
  memory. A regression verifies replacement cannot delete controller-owned memory
  before discovering that task snapshot synchronization is unavailable.
- Synchronous permission exemptions in `utils/permissions/filesystem.ts`, the
  memory command, actual protected mutations/private file modes, admitted setup
  timing and snapshot copy/delete/sync remain open. This milestone delivers prompt
  reads, not the complete memory migration or full M2 caller coverage.
- First broad run found four memory assertions failing because the fake filesystem
  treated a trailing-slash directory as missing; its lookup now uses the normalized
  entrypoint parent. The first kernel run also found plugin discovery consulting
  mutable memory settings with no canonical authority when no agent used memory.
  Memory policy lookup now runs only when a memory-bearing plugin agent exists.
  Logs retained: `/tmp/agenc-memory-content-hermetic.log` and
  `/tmp/agenc-memory-content-kernel.log`; neither is successful qualification.
- Corrected production build/entrypoints/SDK checks passed:
  `/tmp/agenc-memory-content-build-corrected.log`. Corrected production and
  test-support typecheck passed: `/tmp/agenc-memory-content-typecheck-corrected.log`.
- Corrected affected hermetic run passed **2,377 tests / 169 files, zero skips,
  exit 0**, `/tmp/agenc-memory-content-hermetic-corrected.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/tools/AgentTool tests/agents tests/plugins tests/config tests/commands/memory tests/utils/permissions --reporter=dot`.
- Corrected Docker kernel probe passed, exit 0:
  `/tmp/agenc-memory-content-kernel-corrected/` and sibling `.log`. It reads different
  task/controller memory at identical paths, reloads changed task memory, retains
  old catalog prompts and follows a contained absolute intermediate symlink through
  the real worker. The log's phrase "agent-memory snapshots" refers to captured
  catalog prompts, not snapshot copy/synchronization, which remains unsupported.
  All existing process/filesystem/recovery/role probes also passed.
- A final focused source-authority regression was added for explicit remote memory
  at equal `/app` paths across environment generations and mismatched binding
  refusal. Its run passed **28 tests / 4 files, zero skips, exit 0**:
  `/tmp/agenc-memory-content-source-authority.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host/role-environment.test.ts tests/execution-host/agent-memory-content.test.ts tests/execution-host/plugin-registration.test.ts tests/tools/AgentTool/agentMemory.workspace.test.ts --reporter=dot`.
- All handles from this continuation are terminal, including focused session 7876.
  `git diff --check` passed; kernel fixtures were removed; no commits were made.
  Next work remains actual protected memory mutation/snapshot/permission handling
  and its admitted effect timing, followed by the remaining original ledger work.
  No blocker or complete-plan claim exists.

Protected permission path evidence (2026-09-14):

- Re-read the objective, repository instructions and authoritative worktree.
  The preceding workflow-prompt turn made no implementation progress. Source
  inspection corrects an earlier handoff assumption: the filesystem permission
  entrypoints and their memory carve-outs are synchronous, including the path
  resolution that runs before memory authorization. They still require migration.
- Added `ExecutionFilesystem.readLink(expectedDescription)` and its Docker
  implementation. It binds the observed symlink through a held parent, checks
  exact identity before/after reading, validates bounded lossless UTF-8 target
  bytes and releases both handles on success/failure. It performs no task process
  launch, mutation or host path lookup. `filesystem_bound_readlink` negotiation
  rejects older hosts before acquisition. The existing native readlink operation
  now checks the held parent/named entry before and after `readlinkat`; worker
  protocol is 8 and matching supervisor readiness is required.
- New `execution/permission-path.ts` walks task path components with protected
  metadata and symlink reads. It retains lexical input and every intermediate
  symlink expansion for later rule evaluation, preserves kernel ordering of
  symlink traversal and `..`, handles missing destinations through existing
  ancestors, uses only explicit task cwd/home, rejects loops/special resources,
  and rechecks observed entries and absence before returning. Results are not
  cached across environments or calls. These are permission observations, not
  substitutes for descriptor-bound read/mutation guards at operation time.
- The production permission entrypoints do **not yet use this resolver**. This
  is a verified prerequisite for the selected permission path, not completion
  of memory authorization, M2 or all filesystem migration. Next: wire protected
  evidence into asynchronous permission evaluation while preserving explicit
  deny/ask ordering and exact workspace-role memory ownership. Audit synchronous
  internal exemptions and shell path validation as part of that integration;
  replacing only memory's final lstat would leave earlier host lookups intact.
- Build (including native binaries, entrypoint and SDK checks) and production /
  test-support typecheck passed, exit 0:
  `/tmp/agenc-permission-path-build.log`, `/tmp/agenc-permission-path-typecheck.log`.
- Affected hermetic selection passed **252 tests / 34 files, zero skips, exit 0**:
  `/tmp/agenc-permission-path-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/tools/AgentTool tests/utils/permissions --reporter=dot`.
  A focused verbose run verified discovery of the new tests rather than relying
  on prior handoff counts: **22 tests / 2 files, zero skips, exit 0**,
  `/tmp/agenc-permission-path-focused.log`; selection was
  `tests/execution-host/permission-path.test.ts tests/execution-host/docker-filesystem.test.ts`.
- Python host unit suite passed **61 tests, zero skips, exit 0**:
  `/tmp/agenc-permission-path-python.log`, command
  `/usr/bin/python3 -B -m unittest discover -s runtime/tests/execution-host -v`.
- Docker kernel probe passed, exit 0:
  `/tmp/agenc-permission-path-kernel/` and sibling `.log`. The new real-worker
  probe covers symlink chains, dangling/new destinations, symlink-before-`..`
  behavior, loops, FIFO rejection and deterministic link replacement between
  controller validation and worker read. Replacement fails with `path_conflict`.
  Existing containment, process recovery and filesystem probes also passed.
  Renamed the role probe's misleading “agent-memory snapshots” log wording to
  “agent-memory prompt capture”; actual snapshot synchronization remains open.
- All handles are terminal: typecheck 27784, build 96239, affected tests 60152,
  kernel 92892, focused tests 91763. No fixture containers remain; no commits
  were made. The complete goal remains active, with all other ledger gaps intact.

Protected compatibility permission evaluation (2026-09-14):

- Re-read the objective and repository instructions. The preceding protected
  permission resolver milestone was verified implementation progress. The full
  goal is still active; no requirement scope was reduced.
- `utils/permissions/filesystem.ts` read/write tool checks are asynchronous and
  dispatch selected environments to `utils/permissions/execution-filesystem.ts`.
  Local checks retain their existing implementation. Selected checks ignore
  caller-precomputed host paths, resolve task path/working-directory evidence
  through the protected worker, and preserve intermediate-path deny evaluation,
  read ask precedence, edit allowances and protected-path safety decisions.
  Rule matching accepts explicit task cwd/project root/home; home-relative rules
  cannot silently use controller HOME. Existing operator configuration origins
  retain their explicit lexical rule roots, without querying their task metadata.
- Task project/local memory exemptions use captured role authorization, selected
  file identities and every resolved path form. They reject foreign roles,
  multiply-linked files and leaf links, including links reached through another
  alias. The path evidence now records symlink paths and whether the resolved
  leaf involved a symlink. Missing private files remain eligible for creation.
  A matching ask rule cannot turn a memory ownership failure into an allow under
  bypass; the equivalent local read ordering was fixed and regression-tested.
- Selected checks reject a foreign role binding and a changed ConfigStore or
  role-workspace authority before settlement, and propagate environment loss.
  Synchronous internal-path exemptions and direct synchronous task-memory
  authorization now reject before their own host lookup. Controller user/remote
  memory and other controller internal paths still need an explicit task-visible
  bridge; a coincident task path does not acquire controller permissions.
- **M2 is still incomplete.** The caller audit identified the separate canonical
  `permissions/path-validation.ts:checkToolPathPermission` entrypoint used by
  `tools/system/file-read.ts`, `file-write.ts`, `file-edit.ts`, `notebook-edit.ts`,
  `tools/apply-patch/tool.ts`, and `permissions/file-write-preview.ts`. It still
  performs synchronous host resolution, as do shell path-validation helpers.
  The compatibility entrypoint migration is not proof that these canonical
  tools are migrated. Next: route their permission evidence through the selected
  environment while preserving their own rule aliases, explicit cwd/extra roots,
  signed-root updates and plan authority. Then finish actual file/helper dispatch
  and controller artifact bridging; avoid another disconnected permission policy.
- Initial production build and typecheck passed. First affected hermetic run
  failed with one import-boundary assertion and one skipped project-trust test:
  `/tmp/agenc-permission-evaluation-hermetic.log` (1,419 passed, 1 failed,
  1 skipped / 88 files, exit 1). Neither failing source/test was changed relative
  to HEAD before this run. The boundary used textual grep and counted an existing
  documentation reference in `permissions/read-only-grant.ts` as an import.
  It now parses candidate import/re-export records with TypeScript, with a
  regression covering documentation, static/dynamic imports and re-exports; its
  frozen importer baseline was not expanded.
- The trust test previously skipped on case-sensitive volumes. It now verifies
  distinct case spellings do not share trust on those volumes; the original
  same-directory alias assertions remain on case-insensitive volumes. Both
  behaviors reflect actual filesystem identities. This Linux run does not prove
  the case-insensitive branch, and no such claim is made.
- First kernel run failed because adding the real permission entrypoints pulled
  in classifier text assets loaded via createRequire:
  `/tmp/agenc-permission-evaluation-kernel.log`. The disposable controller builder
  now copies the actual production classifier assets, matching runtime packaging
  without stubbing permission dependencies or changing the production feature set.
- Corrected build/entrypoint/SDK checks and production/test-support typecheck
  passed, exit 0: `/tmp/agenc-permission-evaluation-build-corrected.log`,
  `/tmp/agenc-permission-evaluation-typecheck-corrected.log`.
- Corrected affected hermetic run passed **1,422 tests / 88 files, zero skips,
  exit 0**, `/tmp/agenc-permission-evaluation-hermetic-corrected.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/tools/AgentTool tests/permissions tests/utils/permissions --reporter=dot`.
- Corrected Docker kernel probe passed, exit 0:
  `/tmp/agenc-permission-evaluation-kernel-corrected/` and sibling `.log`.
  Real role-content probe now checks memory permissions through the actual
  compatibility entrypoints: private task memory allows, explicit read deny
  survives bypass, and creating a task hardlink revokes read/write permission
  while the equal controller path remains unchanged. Existing probes also pass.
- All handles are terminal: initial typecheck 90971/96995, build 80240, failed
  hermetic 4648/kernel 18677, corrected build 21399/typecheck 88338,
  corrected hermetic 5633/kernel 83476. `git diff --check` is clean, no fixture
  containers remain, and no commits were made. All remaining original ledger
  requirements, including full-suite and end-to-end qualification, remain open.

Canonical file-tool permission integration (2026-09-14):

- Re-read the objective and repository instructions. The previous compatibility
  permission milestone was verified implementation progress. The original full
  contract remains active and unblocked.
- `permissions/path-validation.ts:checkToolPathPermissionAsync` now selects
  protected task resolution when a workspace environment is bound, preserving
  the canonical surface's rule aliases, precedence, explicit cwd and extra roots,
  protected-path checks, bypass handling, and signed transient-root updates.
  Canonical FileRead, Write, Edit, MultiEdit, NotebookEdit and every patch target
  now call it asynchronously. The synchronous API remains for local execution
  and rejects selected execution before host lookup; the exported synchronous
  path/glob validators and path-allow helper have the same guard.
- Shared `execution/permission-authority.ts` captures environment/role identity
  and exact memory ownership for both permission surfaces, while each surface
  retains its own rule policy. Memory remains tied to the role's workspace even
  when a file tool uses another explicit cwd. Foreign bindings, task generation
  loss and authority replacement cannot produce a settled permission allow.
  Controller plan/durable-memory path coincidences do not receive task grants;
  their task-visible bridges remain to be implemented.
- Selected canonical permission evidence uses task HOME, preserves Unicode path
  identity, and records literal quoted/glob-character filenames rather than
  stripping shell quotes or checking only a glob's parent. Explicit file denies
  therefore apply even in bypass mode. Syntax-related asks for other literal
  filenames preserve bypass behavior while explicit deny and memory safety still
  win. The resolver additionally records the canonical spelling of each symlink
  before expansion, preventing `/app/../alias` from hiding an `/alias` deny from
  literal rule matching. Existing local syntax behavior remains unchanged.
- Approval preview's local path now awaits the asynchronous permission API.
  Selected previews explicitly return unavailable before host path/read-cache
  access, because existing read/editor cache entries lack environment provenance.
  This is a temporary refusal, **not delivered task preview compatibility**.
  A regression verifies neither host safePath nor the unbound snapshot reader
  is called in that branch. Full selected previews must return after the cache
  and filesystem migration, including correctly verified missing-file previews.
- New tests invoke the actual FileRead/Write/Edit/MultiEdit/NotebookEdit/patch
  permission callbacks with a task backend, exercise canonical intermediate-path
  FileRead/Write denies and later denied patch targets, verify signed outside
  roots, explicit cwd/task home, role-origin memory, hardlink rejection, literal
  path denies, generation death and preview source separation.
- Initial build/typecheck passed. First affected run failed six assertions that
  still treated tool permission results as synchronous:
  `/tmp/agenc-canonical-permission-hermetic.log` (2,404 passed / 6 failed,
  140 files, exit 1). Auditing all affected callback tests found one additional
  negative test that could pass by reading `undefined` from an unawaited Promise.
  All seven now await the result; the signed-root injection test explicitly
  expects an ask. Corrected run passed 2,410 / 140, zero skips, exit 0 at
  `/tmp/agenc-canonical-permission-hermetic-corrected.log` before the final literal
  filename regressions. The initial kernel run also passed; it did not yet cover
  the final literal-filename changes.
- Final production/native/entrypoint/SDK build and production/test-support
  typecheck passed, exit 0:
  `/tmp/agenc-canonical-permission-build-verified.log`,
  `/tmp/agenc-canonical-permission-typecheck-verified.log`.
- Final affected hermetic run passed **2,410 tests / 140 files, zero skips,
  exit 0**, `/tmp/agenc-canonical-permission-hermetic-verified.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/permissions tests/tools/system tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
- Final Docker kernel probe passed, exit 0:
  `/tmp/agenc-canonical-permission-kernel-verified/` and sibling `.log`.
  The real-worker role probe now checks canonical and compatibility memory
  permissions against the same task file, observes permission revocation after
  creating a task hardlink while the controller shadow stays unchanged, and
  verifies explicit denies for real quoted and glob-character task filenames.
  Existing process, filesystem, containment and recovery probes also passed.
- **Actual file execution remains open (M2/F2/E3), not hidden by these results.**
  `tools/system/filesystem.ts:canonicalize/safePath` still use host metadata;
  FileRead's `resolveAndCheck` normalizes against host-oriented helpers and its
  ordinary reads bind a held capability only for existing delegated/editor cases.
  Text/notebook/image/PDF paths still contain host reads or conversion helpers.
  Write/Edit transaction preflight and shared workspace factories also remain
  host-based. Read snapshots, persisted local history, editor buffers and previews
  require environment identity. The `/root` agent-namespace check still rejects
  legitimate selected-task `/root` paths; remove that conflation as filesystem
  dispatch is migrated, without enabling a host fallback. Task tilde and symlink
  plus `..` execution must match the protected permission path semantics.
  Next: migrate safe-path resolution and actual bound file reads/writes plus
  cache provenance, then helper execution, restoring task preview compatibility.
- All handles from this continuation are terminal, including final build 77991,
  typecheck 83304, affected tests 12186 and kernel 96681. `git diff --check`
  passed; no fixture containers remain and no commits were made. The complete
  original ledger, including CLI/bootstrap, full execution ingress, durable
  recovery integration, installer/preflight, Harbor and final gates, stays open.

Protected FileRead and read-history integration (2026-09-14):

- The workflow-prompt turn made no implementation progress. Re-read the objective,
  repository instructions and current sources; resumed the unfinished read/cache
  integration without narrowing the full acceptance contract.
- `execution/tool-file-read.ts` binds text/notebook reads through the selected
  filesystem. It resolves task cwd/HOME and symlink-plus-`..` paths, checks all
  path forms against trusted roots and exact role-memory authority, and compares
  protected file/root identities before publishing. Environment/role changes
  and environment loss propagate. No task program executes in this path.
- Canonical permission results sign the task path forms they evaluated, including
  intermediate aliases. FileRead uses that evidence without a second host
  normalization or an independently resolved, unchecked signing pass. Selected
  `/root` paths are treated as task filesystem paths. Local namespace checks
  remain. Direct unsigned outside-root reads remain denied.
- `ExecutionFilesystem.bindFileRead` now includes exact held descriptions. Docker
  acquisition binds an absolute file path and correlates the held lexical parent
  before returning the capability. Leaf symlinks to another directory remain
  legitimate; target-parent equality is not required. Existing descriptor-bound
  bytes/window reads and capability disposal remain in place.
- Session read maps, shared conversation reads and private controller history
  filenames now include environment identity. Recorded task reads require explicit
  source binding. Foreign/unbound entries cannot grant task read-before-write
  authority; old unbound transcript seeds retain local semantics. Persisted history
  now writes and restores binding, raw content and range metadata; snapshot exports
  include binding. Controller history remains outside the task filesystem.
- `prompts/attachments/changed-files.ts` now uses protected task reads and validates
  source/role authority before updating snapshots or emitting attachments. It does
  not read controller shadows at cached task paths, and environment death is not
  swallowed as an optional missing attachment. Task reads are bounded to 16 MiB;
  unchanged content is suppressed even when metadata changes.
- Selected FileRead does not consult the still-unscoped editor overlay/listeners.
  Selected image/PDF reads explicitly refuse before host reads/conversion helpers.
  These are temporary integration limitations, **not delivered editor or media
  compatibility**. Preview remains temporarily unavailable pending protected
  preview/editor integration. Write/Edit/patch, other cache producers and remaining
  task filesystem/helper callers still require migration. E3/F2/M2 remain open.
- Build passed at `/tmp/agenc-task-file-read-build.log` (exit 0). An initial
  typecheck found one unused legacy capability import; it was removed. Corrected
  and final production/test-support typechecks passed at
  `/tmp/agenc-task-file-read-typecheck-corrected.log` and
  `/tmp/agenc-task-file-read-typecheck-final.log` (exit 0).
- Affected hermetic suite passed **2,651 tests / 161 files, zero skips, exit 0**,
  `/tmp/agenc-task-file-read-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/permissions tests/tools/system tests/prompts/attachments tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
  New tests cover real FileRead text/notebook behavior with host shadows, absence
  of unscoped editor reads, automatic task changes, environment loss, rejected
  replacement, equal-path local/two-container read grants and persisted recovery.
- First kernel attempt `/tmp/agenc-task-file-read-kernel/` (exit 1) passed the
  existing containment probes, then stopped at the newly added FileRead fixture:
  default token-limit lookup requires provider authority. The fixture now passes
  its 25,000-token limit explicitly. This was a fixture setup failure, not a
  successful kernel qualification.
- Corrected kernel run passed, exit 0, at
  `/tmp/agenc-task-file-read-kernel-corrected/` and sibling `.log`. The real-worker
  role-content probe now also executes FileRead text, offset/limit and notebook
  paths, verifies task symlink-plus-`..` traversal, directly describes/reads a
  cross-directory leaf symlink, checks binding in the read cache and emits a
  protected changed-file attachment while a same-path controller shadow remains.
  Earlier process/FS/containment/recovery probes also passed. This remains fixture
  integration evidence; actual AgenC canonical-journal survival and full Harbor
  qualification remain open.
- All build/typecheck/test handles for this milestone are terminal: build 69539,
  typecheck 17709 (initial failed import), 28036 and 25694 (passed), affected tests
  11534 (passed), kernel 54361 (fixture setup failure), 44360 (passed). No source
  changes followed the passing build/hermetic run; only the kernel fixture's
  explicit token limit and this ledger changed. No commits were made.
- Next integration work: protected previews and environment-scoped editor state,
  selected mutation/patch callers and remaining read-cache producers, then media
  and task-controlled helper dispatch. Cache grants now carry environment binding;
  mutation/preview validation must still bind current file identity. Audit partial
  reads following full reads so inherited raw snapshot bytes cannot masquerade as
  a fresh full snapshot. Normal missing/denied reads and combined read/disposal
  failures also need consistent selected tool error envelopes. Do not enable
  isolated bootstrap until every task-facing path has migrated.

Protected replacement previews and exact read observations (2026-09-14):

- The previous goal turn made verified implementation progress. Re-read the
  objective, repository instructions and current read/preview/mutation sources.
  The complete original acceptance contract remains active.
- `execution/tool-file-read.ts` now exposes protected path observation, including
  absence, separately from regular-file binding. Both retain root/file evidence
  and source/role authority for revalidation. `execution/path-description.ts`
  validates persisted exact metadata without filesystem access and compares all
  identity fields without floating-point timestamp conversion.
- Task snapshots now carry `executionFile` through recording, controller-private
  history, seed/export and rehydration. Validation rejects malformed metadata or
  a description belonging to a different canonical path. Each selected snapshot
  represents one read: it no longer merges fresh partial metadata with stale raw
  bytes, content or flags from an older full read. Local snapshot merging retains
  its existing behavior. Protected changed-file attachments record the identity
  of their observed bytes without inheriting an older full-read display snapshot.
- `permissions/file-write-preview.ts` now supports selected existing and missing
  task files. It checks task roots and current read permission, validates protected
  absence, and requires a prior full task snapshot for existing-file previews.
  Existing previews compare exact identity, then held bytes, and revalidate source
  authority through capability release. Missing paths and same-path controller
  shadows are kept distinct. Partial reads, stale snapshots, changed identities,
  changed bytes, denied paths and oversized/binary text do not produce a replacement
  preview. Environment loss and uncertain cleanup propagate rather than becoming
  optional preview failure. Selected editor overlays remain to be integrated;
  these previews use the selected filesystem and never consult local editor state.
- FileRead stages task snapshots until final validation and successful capability
  release. A failed read or unacknowledged release cannot newly grant a read.
  Ordinary selected missing/denied paths now produce the normal tool error envelope;
  environment failures remain explicit. Combined read/release failures retain
  both errors in an AggregateError rather than replacing the original failure.
- Build and production/test-support typecheck passed (exit 0):
  `/tmp/agenc-protected-preview-build.log`,
  `/tmp/agenc-protected-preview-typecheck.log`, and
  `/tmp/agenc-protected-preview-typecheck-final.log`.
- Docker kernel probe passed, exit 0, at
  `/tmp/agenc-protected-preview-kernel/` and sibling `.log`. The real role-content
  probe now invokes replacement previews after an actual task FileRead, verifies
  a task-missing path despite a controller file at that path, rejects previews
  after partial reads, and rejects stale full snapshots before/after changed-file
  attachment generation. Existing containment/process/FS/recovery probes passed.
- Initial affected hermetic run: **2,652 passed / 1 failed**, 161 files, zero
  skips, exit 1, `/tmp/agenc-protected-preview-hermetic.log`. The new test attempted
  to mutate `createEmptyToolPermissionContext()`'s immutable map. It now replaces
  the permission context with an updated map, preserving the production contract.
  Corrected affected run passed **2,653 tests / 161 files, zero skips, exit 0**,
  `/tmp/agenc-protected-preview-hermetic-corrected.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/permissions tests/tools/system tests/prompts/attachments tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
  Source stayed unchanged after the passing build/typecheck/kernel run; only the
  test context construction and ledger changed. Build 38440, typechecks 94839 and
  65122, initial affected tests 45365, corrected tests 62499, and kernel 22451 are
  all terminal. `git diff --check` passes; no owned kernel fixture containers
  remain, and no commits were made. The full acceptance contract is not satisfied.
- Mutation audit confirms Write still performs host `safePath`, stat/readFile,
  editor lookup and LSP feedback around `prepareWorkspaceMutation` and
  `executeWorkspaceFileMutation`. The latter directly captures the local guard;
  the coordinator registry is keyed by controller home and canonicalizes task
  paths with host realpath. Migrating only the final write would leave these
  bypasses. Next: environment-bound coordinator/editor registry and path authority,
  backend-selected transaction factories and actual Write/Edit/patch preflight,
  mutation, result snapshots and helper feedback. Bootstrap selection must remain
  unavailable until all task-facing execution/FS paths have migrated. All other
  original ledger requirements, including Harbor, installation and final gates,
  remain open.

Environment-bound coordinator paths and controller persistence (2026-09-14):

- The previous goal turn made verified progress. Re-read the objective, repository
  instructions and coordinator/transaction sources. The original full contract
  remains active; this is E3/M2 integration progress, not completed isolation.
- Added `execution/coordinator-paths.ts:ExecutionCoordinatorPaths`. Selected
  ingress resolves task paths asynchronously through the protected filesystem,
  rechecks observations across the preparation batch, then supplies exact admitted
  paths to the existing synchronous coordinator state machine in an async scope.
  Unprepared paths fail before host lookup. Task symlink-plus-`..`, explicit task
  HOME, canonical identities and preparation races are covered. Historical token
  and persisted paths use validated lexical identities rather than re-resolving
  a task path against the controller or against a replacement task inode.
- `WorkspaceMutationCoordinator`, its registry and the public authority facade
  accept the explicit path authority. The facade partitions registries by both
  canonical controller home and immutable environment binding. Selected state is
  persisted beneath a controller-owned environment namespace; local ledger paths
  retain their previous layout. Task quarantine discovery, hydration and ledger
  parsing preserve admitted root/path identities without host realpath of task
  names. Local coordinator construction in selected ambient authority rejects
  omitted execution authority before host path inspection.
- Registry identity and filesystem owner are separate: sessions sharing an
  environment share editor coherence, while each `preparePaths` call uses its
  calling ConfigStore's filesystem client or an explicitly supplied workspace.
  The path authority checks immutable binding equality before preparing paths.
  A closed earlier client's filesystem is not borrowed by a later session, and
  the preparation scope uses the calling session's cwd/HOME. Explicit daemon
  callers outside canonical session scope can pass the workspace to the registry's
  `preparePaths` method. Its default remains the explicitly bound original client.
- `canonicalWorkspaceRoot` now resolves selected roots through the protected
  filesystem before normalizing dot-dot and checks source/role authority. It
  propagates environment death and rejects non-directory roots. Local behavior
  remains unchanged.
- New hermetic tests exercise dirty-buffer authority, aliases, same-path local
  and foreign environments, foreign lease/tool-operation tokens, controller-only
  quarantine persistence and restoration, absence of host realpath calls for task
  names, scoped preparation, path races, environment death, and replacement of a
  closed filesystem owner without changing registry identity. The real-worker
  role-content probe now uses the public facade to acquire/sync/read selected
  editor state and restores its quarantine with protected paths after a new
  registry is created; it also validates task workspace roots.
- Initial build/typechecks passed. Initial affected run passed **2,794 tests /
  164 files, zero skips**, `/tmp/agenc-coordinator-environment-hermetic.log`,
  exit 0, and initial kernel probe passed at
  `/tmp/agenc-coordinator-environment-kernel/` and sibling `.log`. These precede
  the final public root-validation and per-calling-owner preparation tests.
- Final build and production/test-support typecheck passed, exit 0:
  `/tmp/agenc-coordinator-environment-build-verified.log`,
  `/tmp/agenc-coordinator-environment-typecheck-qualified.log`.
- Final affected hermetic run passed **2,796 tests / 164 files, zero skips,
  exit 0**, `/tmp/agenc-coordinator-environment-hermetic-verified.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/workspace tests/permissions tests/tools/system tests/prompts/attachments tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
- Final Docker kernel probe passed, exit 0:
  `/tmp/agenc-coordinator-environment-kernel-verified/` and sibling `.log`.
  Current coordinator/editor checks and existing process/FS/containment/recovery
  checks pass. This is still fixture integration, not proof of a complete AgenC
  run's canonical journal survival or Harbor grading.
- All handles are terminal: first typecheck 6459, builds 80594/61206/9526,
  typechecks 53955/49996/98863, affected tests 50226/41416 and kernel
  64528/69925. No source changes followed final qualification. `git diff --check`
  passes; no owned Docker fixture containers remain. No commits were made.
- **Still required:** migrate task-facing coordinator callers to `preparePaths`,
  propagate binding through editor ingress/transport/events, and integrate selected
  editor overlays with read snapshots/previews. The new core does not make those
  callers complete. Migrate transaction factories and actual Write/Edit/patch
  preflight/effects together, retaining the preflight file identity through the
  bound transaction and preserving unknown-outcome reconciliation. Review explicit
  captured-local registries at selected ingresses so an old reference cannot
  bypass environment dispatch. Daemon operations without ambient ConfigStore must
  supply their operator-bound workspace explicitly. Bootstrap, remaining helpers,
  durable run recovery, installer/preflight, Harbor and all final acceptance gates
  remain open. Do not enable isolated bootstrap while any caller can use host task
  paths or launch task-controlled code on the controller.

Shared filesystem factories and selected transaction failure handling (2026-09-14):

- Re-read the objective and repository instructions. The preceding coordinator
  turn made verified progress. The full plan remains the acceptance contract.
- Shared `bindWorkspaceDirectoryReadCapability`, `bindWorkspaceFileReadCapability`,
  `bindWorkspaceDirectoryMutation` and `captureWorkspaceFilePathTransactionGuard`
  now select the configured execution filesystem before host resolution, metadata
  or helper startup. Acquisition validates the captured workspace authority and
  disposes rejected capabilities without discarding a simultaneous release error.
  Existing expected read identities are checked against exact held descriptions.
  Directory capabilities now expose protected descriptions like file capabilities.
- Selected `executeWorkspaceFileMutation` rejects legacy unbound write callbacks
  before admission/dispatch. Backend-reported pre-effect failure cancels without a
  compensating mutation. Native/host acknowledgement failures after the mutation
  boundary retain their original error, inspect only for evidence, and reconcile
  the coordinator as `unknown_outcome`; they do not authorize rollback. Verified
  transaction-owned post-state rollback remains supported for ordinary failures.
  Transaction/release failures retain both errors. This does not yet migrate the
  actual tools' preflight, approval, helper feedback or all recovery call sites.
- Coordinator preparation now deactivates its async scope when the operation
  settles, including async descendants that inherited AsyncLocalStorage. A late
  callback cannot turn a previously prepared path into fresh lookup authority.
- New hermetic checks use the actual Docker filesystem adapter through the shared
  factories, reject stale expected identities, and verify complete handle release.
  A lost-acknowledgement test verifies unknown reconciliation even when subsequent
  inspection sees the original bytes; that observation cannot prove no effect.
- `tests/execution-host/workspace-transaction-probe.ts` runs from the real-worker
  role-content fixture. It exercises shared bound reads and guard acquisition,
  a coordinated successful write, verified conditional rollback, and injected
  loss of a mutation acknowledgement. The latter executes exactly one write,
  preserves the task result and records `unknown_outcome` in the controller-side
  coordinator ledger. A same-path controller shadow remains untouched. This is
  fixture-level coordinated mutation evidence, not the final AgenC run journal
  survival or Harbor qualification.
- Build and production/test-support typecheck passed, exit 0:
  `/tmp/agenc-workspace-factories-build.log`,
  `/tmp/agenc-workspace-factories-typecheck.log`,
  `/tmp/agenc-workspace-factories-typecheck-final.log`.
- Affected hermetic run passed **2,798 tests / 164 files, zero skips, exit 0**,
  `/tmp/agenc-workspace-factories-hermetic.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/workspace tests/permissions tests/tools/system tests/prompts/attachments tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
- Docker kernel probe passed, exit 0, at
  `/tmp/agenc-workspace-factories-kernel/` and sibling `.log`.
  Build 49750, typechecks 10534/41424, affected tests 57981 and kernel 81654 are
  terminal. No commits were made. Remaining work includes actual Write/Edit/patch
  preflight and guard continuity, selected editor overlays/transport, all other
  task-facing helpers, bootstrap, durable run recovery, installation, Harbor and
  complete final qualification. E3/F2/M2 and the other original ledger entries
  remain open.


Selected Write preflight and effect integration (2026-09-14):

- Re-read the objective, repository instructions and current worktree. The prior
  workflow-prompt response made no implementation progress. The full original
  acceptance contract remains active; this entry records a caller integration,
  not completion of M2 or the overall plan.
- `tools/system/file-write.ts` now branches to the selected execution environment
  before controller path resolution, stat/read, editor lookup or helper feedback.
  Its default cwd/allowed root comes from the bound task workspace and role.
  Protected path evidence includes signed additional roots and role-memory
  ownership; selected memory secret screening uses the deterministic scanner
  without controller memory-path classification. Task `/root` is accepted by the
  selected permission/execution branch when authorized.
- The selected shared capture factory issues preflight guard provenance tied to
  the exact ExecutionWorkspace object. `executeWorkspaceFileMutation` can consume
  that guard once, only for its original path and authority, before admission.
  The caller owns release across refusals, admission failures and effects. Foreign,
  wrong-path, unregistered and reused guards fail before dispatch. Original read
  bytes and held identity now survive the read gate and coordinator admission.
- Selected Write requires an environment-scoped prior read for overwrites and
  compares exact file metadata even for partial reads. Full snapshots also compare
  normalized original bytes. The actual bound mutation retains the original guard;
  post-write snapshots publish only after protected byte/metadata verification and
  successful capability release. Environment/unknown-outcome errors and combined
  release failures retain their evidence. There is no compensating replay after
  lost acknowledgement. Success callbacks remain the existing operator/session
  skill-discovery callbacks; selected Write does not invoke the unmigrated LSP
  feedback helper.
- The first real Write creation probe found a shared wrapper integration bug:
  passing `guard.assertOriginalState` as a bare callback lost the native class
  receiver. The wrapper now supplies a closure. A hermetic regression invokes that
  callback using an actual Docker filesystem adapter and verifies no recapture,
  caller-owned release and guard provenance rejection. Initial kernel attempts
  failed before mutation receipts; evidence is retained in
  `/tmp/agenc-selected-write-kernel/` and
  `/tmp/agenc-selected-write-kernel-diagnose/` with sibling logs.
- The real-worker `workspace-transaction-probe.ts` now exercises the actual Write
  tool under ConfigStore and coordinated mutation authority: create despite an
  existing controller shadow, exact Unicode/CRLF bytes, overwrite using the new
  snapshot, unread-session refusal, partial-read authorization, stale snapshot
  refusal and a competing write in the final-check window. Actual Write lost-ACK
  injection proves exactly one mutation, preserves the task result and prior read
  snapshot, and records unknown_outcome in the controller coordinator journal.
  Existing low-level rollback and original-ACK-loss cases also pass. This remains
  fixture integration, not V1 full-session canonical-journal or Harbor evidence.
- Corrected build and production/test-support typecheck passed, exit 0:
  `/tmp/agenc-selected-write-build-corrected.log`,
  `/tmp/agenc-selected-write-typecheck-corrected.log`.
- Corrected affected hermetic suite passed **2,799 tests / 164 files, zero skips,
  exit 0**, `/tmp/agenc-selected-write-hermetic-corrected.log`. Command:
  `PATH=/tmp/agenc-node-26.5.0/bin:$PATH node runtime/scripts/run-hermetic-test-boundary.mjs run tests/execution-host tests/workspace tests/permissions tests/tools/system tests/prompts/attachments tests/tools/apply-patch tests/tools/AgentTool tests/tools/filesystem-dispatch-roots.test.ts --reporter=dot`.
- Corrected Docker kernel probe passed, exit 0:
  `/tmp/agenc-selected-write-kernel-corrected/` and sibling `.log`.
  All build/test handles are terminal, including corrected build 75122,
  typecheck 89623, hermetic 83101 and kernel 76643. Initial build 49136,
  typechecks 55304/51263, hermetic 81234, kernels 83482/62546 are also terminal.
  No owned Docker fixture containers remain; `git diff --check` passes.
  No commits were made.
- **Still required for Write:** protected automatic creation of missing parent
  directories (native capture currently requires the immediate parent), selected
  editor-overlay read/approval/admission compatibility, environment-bound LSP
  feedback, broader selected-tool acceptance tests and capability-aware guidance.
  The native file-content/backup limits still require migration. Do not mark Write
  or M2 complete based on these passing cases. Continue Edit/patch and all other
  task-facing callers, early bootstrap, durable recovery, installer/preflight,
  Harbor migration and every final acceptance gate. Isolated bootstrap must remain
  disabled while any caller can use controller task paths or helpers.


Recursive guard ancestor creation (2026-09-14):

- The preceding coordinator turn implemented this step and launched its
  qualification, then ended on a provider usage limit before reading the
  results or recording them. This entry records that work from the retained
  worktree and logs; the continuation entry below re-verified it.
- Native filesystem worker protocol 9: `capture` may resolve an absent
  ancestor and retains the remaining components on the guard. Missing
  components cannot be traversed through `..` or a trailing slash, and a
  regular-file transaction never adopts an existing entry. The capture
  response reports `missingParents`; the supervisor client and TypeScript
  adapter reject an existing target that reports missing ancestors, and the
  adapter negotiates `filesystem_recursive_guard` before creating a worker.
- Parent creation is part of the admitted write, never capture/preflight:
  each missing component is created exclusively (`mkdirat` through the held
  parent; EEXIST restores the earlier effect state), reopened with
  `O_DIRECTORY|O_NOFOLLOW`, pushed onto the held chain, fsynced and
  re-checked against the full pathname before the next step. Partial
  directory creation remains a mutation even if the leaf is never created;
  parents are intentionally not removed on failure or rollback.
- `DockerFileGuard` exposes `mayCreateParents`. `executeWorkspaceFileMutation`
  treats any failure after the effect boundary on such a guard as
  `unknown_outcome` (original error retained as cause) instead of a file-only
  rollback, reconciling the coordinator without a compensating write. Hermetic
  tests verify that an absent final file cannot cancel a parent-creating
  effect and that hosts without recursive guard evidence are rejected before
  a worker is connected.
- Kernel `recursive_guard_probe`: read-only capture leaves the tree absent, a
  nested binary create succeeds, a newly occupied ancestor is refused as
  `path_conflict` without mutation, an injected directory acknowledgement
  failure after the first `mkdir` reports `mutation_started` with the partial
  directory retained, and a held-parent exchange (rename plus replacement
  symlink) between components fails as `path_conflict` with neither
  replacement receiving an entry. Dot-dot and trailing-slash missing paths
  are rejected at capture. The real-worker transaction probe creates
  `write-nested/one/two/file.txt` through the actual Write tool and proves a
  post-write fault after ancestor creation settles as `unknown_outcome` with
  the written bytes preserved and no session snapshot published.
- Interrupted-turn evidence, all terminal: typecheck
  `/tmp/agenc-recursive-guard-typecheck-final.log`; affected hermetic run
  **2,801 tests / 164 files, zero skips**
  `/tmp/agenc-recursive-guard-hermetic.log`; Python host tests 61 OK
  `/tmp/agenc-recursive-guard-python.log`; kernel probe
  `/tmp/agenc-recursive-guard-kernel/` and sibling `.log` with every probe
  line passing, though the runner exit status was not captured before the
  turn ended. The continuation entry below re-ran build, typechecks, Python
  and the kernel probe on the same sources with exit 0.
- Still open: the local (non-selected) guard keeps each tool's existing host
  `mkdir -p`; the remaining native file-content/backup limits and every item
  listed under selected Write remain required.

Selected Edit and MultiEdit integration (2026-09-14):

- Resumed after the provider interruption. Re-read the ledger, the retained
  logs and the worktree; no implementation from the interrupted turn was
  lost. This entry records the next caller migration, not completion of M2.
- `tools/system/file-edit.ts` branches to the selected execution environment
  before any controller path resolution, host stat/read, editor overlay lookup
  or LSP feedback. `Edit` and `MultiEdit` share `executeTaskFileEdit`:
  protected path evidence with signed additional roots, role-memory secret
  screening through the deterministic scanner, one preflight guard captured
  through the shared factory and consumed once by the transaction,
  environment-scoped read-before-write comparing exact protected metadata
  even after partial reads plus full-snapshot bytes, the existing
  empty-`old_string` create/occupied semantics, all-or-nothing batch
  validation before admission, CRLF/UTF-16 preservation from the held original
  bytes, coordinator admission, bound mutation, and a snapshot published only
  after a fresh protected read verifies the acknowledged bytes and both
  capabilities release. Missing ancestors are created by the protected write.
  `allowedPaths` is optional like Write; the task branch defaults to the bound
  workspace root, and its permission check uses the role cwd without treating
  the task home as the agent namespace. The MultiEdit all-or-nothing message
  moved into a shared helper with unchanged wording. The selected path does
  not invoke the unmigrated LSP helper.
- `tests/execution-host/task-files-fixture.ts` gains in-memory transaction
  guards (original identity, expected-state checks, missing-parent evidence,
  lost-acknowledgement injection, write and release counting) so tool-level
  hermetic tests drive the real tools under `ConfigStore` authority.
- New `tests/execution-host/tool-file-edit.test.ts`: read-before-write refusal
  with no-effect disposition, CRLF-preserving edit against a controller shadow
  at the same name, the post-edit snapshot authorizing the next edit,
  equal-bytes/new-identity staleness, missing-file refusal, relative create
  through missing ancestors, occupied-create refusal, all-or-nothing batch
  refusal and success, no editor or LSP consultation; a verified post-edit
  fault rolling back to the original bytes and leaving the prior snapshot
  stale; lost acknowledgement settling as `unknown_outcome` with exactly one
  write and the prior snapshot retained; environment death propagation; and
  permission checks resolving relative targets against the role cwd with the
  task home editable.
- The real-worker transaction probe now runs the actual Edit/MultiEdit tools
  under coordinated mutation authority: a seeded CRLF file, replacement with
  the controller shadow untouched, unread-session refusal, partial-read
  authorization, stale refusal, nested create through missing ancestors,
  refused and applied batches, verified rollback, and lost-ACK injection with
  exactly one mutation, preserved task bytes, retained prior snapshot and
  coordinator ledger `applied`/`unknown_outcome` entries for the edit paths.
- Typecheck (production and test support) passed, exit 0. Build, package
  entrypoint and generated SDK checks passed, exit 0,
  `/tmp/agenc-selected-edit-build.log`. Affected hermetic run passed
  **2,804 tests / 165 files, zero skips, exit 0**,
  `/tmp/agenc-selected-edit-hermetic.log`, same command as the preceding
  entries. Python host tests 61 OK, exit 0,
  `/tmp/agenc-selected-edit-python.log`. Disposable Docker kernel probe passed,
  exit 0, `/tmp/agenc-selected-edit-kernel/` and sibling `.log`, including
  the recursive guard probe and the extended transaction probe. No owned
  fixture containers remain; `git diff --check` passes. No commits were made.
- **Still required:** `apply_patch` and `NotebookEdit` selected branches,
  selected editor-overlay read/approval/admission compatibility,
  environment-bound LSP feedback, the native file-content/backup limits,
  early bootstrap, durable recovery, installer/preflight, Harbor migration and
  every final acceptance gate. Do not mark M2 complete. Isolated bootstrap
  must remain disabled while any caller can use controller task paths or
  helpers.
