# Execution host internals

This directory implements host-side operational authority for issue #2477. The
implementation ledger in `docs/design/execution-environment-implementation.md`
tracks the still-required controller integration and acceptance gates. These
components alone do not establish end-to-end AgenC run isolation.

The supervisor and runtime adapter use Python's standard library. Installed
entrypoints must use an absolute isolated interpreter, an immutable module
directory, protected configuration, and pinned runc 1.5.1. The filesystem worker
is a static native executable built from `runtime/native/agenc-filesystem-worker.c`.
The runtime build packages the executable and these modules in `dist`.
It also builds the static `agenc-task-launcher`, which runs inside a managed
task scope and applies the admitted argv and environment just before exec.

## Authority and receipt boundaries

`controller.sock` accepts only configured host UIDs. `runtime.sock` accepts only
host root and obtains the adapter PID from `SO_PEERCRED`. Neither endpoint, the
supervisor state directory, nor controller credentials may be mounted into a
task. Sessions register an immutable generation and monotonically advancing
authority revision before allocating operations. A task cannot supply a new
binding through tool arguments.

Host RPC uses a four-byte big-endian length followed by a JSON object, bounded
at 2 MiB. Stdout, stderr and stdin carry no control messages. A launch allocates
the command cgroup and one-use lease before Docker exec creation. The adapter
claims that lease and moves into a separate host launch scope before it can fork
runc. Cancellation fences claims, empties the launch scope, then kills and
verifies the command scope. Initial command-scope emptiness is not cleanup proof.

SQLite receipts are operational evidence. The controller remains the canonical
run writer. Docker creation/start and input writes record intent before crossing
their respective boundaries. Reconnection looks up the original run/call/attempt
and reads retained output at an explicit byte offset. Missing acknowledgements
never cause another command or input write. Filesystem mutation receipts follow
the same rule; an unsettled intent remains inspectable without replay.

Numeric process handles are allocated in the same durable transaction as the
lease and allocation receipt. Their SQLite AUTOINCREMENT sequence spans owners
and environment generations and does not reuse retired numbers. Existing
operational rows acquire handles in an atomic migration; missing identities in
an already migrated store fail closed. Exhausting JavaScript's safe integer range
rejects allocation before a launch can commit.

The immutable Docker binding also contains the receipt store's handle namespace.
Restoring a binding requires that original namespace, and every bound controller
RPC carries it, including filesystem requests. Replacing the receipt store
therefore cannot silently restore an old session against new numeric handles.
Canonical-coordinate reconnection returns the original operation and numeric
handle without executing it again. Controller checkpoint and manager restoration
are still required integration work; these operational receipts are not canonical
session persistence.

Closing an owner persists an authority fence before draining command scopes.
An old revision cannot reopen it, and delayed leases cannot claim it. Detached
services retain their environment lifetime; explicit handle termination can
still stop them. Inspection and retained output remain available after closing.
After closing the launch fence, cleanup observes command-scope population and
then kills and verifies it empty. A leader-exit receipt plus remaining command
processes produces durable residual-cleanup metadata only after successful
cleanup. The environment-backed unified-exec manager exposes the existing
`residual_processes_terminated` result field without changing the leader's exit
code. Explicit cancellation of a live leader and detached-service cleanup do not
produce that residual-service guidance.

## Task bootstrap and output

Docker adds image defaults to exec environments, and qualified runc also adds a
default HOME. The runtime adapter checks the leased process against Docker's
delivered arguments, cwd, terminal, user and every admitted environment value.
It then launches a sealed anonymous copy of the immutable native task launcher
using a held executable descriptor and runc's supported `--preserve-fds`
interface. The task receives no descriptor to the installed host binary: a root
task retaining `/proc/PID/exe` cannot later reopen the host inode for mutation.
Ordinary unmarked
Docker operations still delegate unchanged.

The launcher receives its executable as fd 3 and a sealed bootstrap memfd
as fd 4. An ordinary bootstrap contains `AGL1`, length-prefixed executable bytes, an argv
vector (including independently specified argv[0]), and an environment vector.
All lengths and vectors are bounded before dispatch and again in native code.
After validating the complete frame, the launcher closes both private
descriptors, replaces its environment, and execs the task. Its PID remains the
pidfd-observed command leader. Task argv and environment never enter host helper
argv, and task stdin remains untouched. The launcher starts only after runc has
established the leased command cgroup and task namespaces.

Bound task cwd/stdin use `AGL2`, which adds an ordered descriptor layout and the
original native worker's inode/version attestations. The supervisor exports the
held directory/regular file before allocating the lease and retains its own file
descriptions. It transfers them only to the root runtime adapter claiming that
lease, using `SCM_RIGHTS` on the separate runtime RPC connection. Releasing the
original read capability does not release the pending launch's description.
Revocation releases it only after the launch fence proves cleanup; a claimed
launch consumes the handoff. Missing descriptions cannot be reconstructed from
fresh pathnames after restart or an uncertain acknowledgement.

The native launcher validates all descriptor identities and the input file's
original version before changing cwd or installing stdin. Docker transports cwd
as `/` for this launch; `fchdir` then selects the held task directory after runc
has established containment. The original requested cwd remains in the receipt.
Additional descriptors occupy fd 5 and optionally 6 and close before the target
program executes. No control messages are multiplexed into stdin. Bound file
input rejects subsequent input RPC and cannot also be a PTY.

The supervisor fsyncs raw Docker output and indexes payload ranges by stream.
Controller cursors can stop inside a binary payload and reconnect without
consuming data or mixing stdout and stderr. Terminal streams have no Docker
multiplexing headers. Output completion requires valid framing, a terminal
Docker exec receipt and a still-live pidfd for the original Docker daemon.
Daemon/stream failure retains available output with an explicit incomplete
outcome; command cleanup alone does not imply output completion.

## Detached services

Environment-lifetime launches use Docker's detached exec mode. The leased host
operation allocates `/tmp/agenc-detached-<operation-id>.log` in the task. The
sealed `AGL3` native bootstrap establishes a session, opens that log exclusively
with append mode and permissions 0600, and redirects stdout/stderr to its shared
file description. Stdin becomes verified task `/dev/null`. Task programs receive
their exact admitted argv/environment and no private startup descriptors.

The runtime hands off a separate inherited `SOCK_SEQPACKET` startup channel in
the same leased descriptor layout. The native launcher sends its task PID and
log description with `SCM_RIGHTS`; the supervisor receives kernel sender
credentials with `SO_PASSCRED`. Bootstrap errors have a distinct bounded packet.
The startup descriptor closes on exec. This operational observation is combined
with the original runtime PID/exit receipts; losing an acknowledgement never
causes another launch. These descriptor and credential mechanisms follow
[Linux UNIX socket semantics](https://man7.org/linux/man-pages/man7/unix.7.html).

The selected unified-exec manager returns the task PID/log path, waits up to the
existing two-second default for early exit, and exposes no model `session_id`
for a detached service. Owner shutdown retains its environment scope. A service
can fork, double-fork or create another session: original leader exit does not
terminate its remaining descendants. Explicit host-owned scope cleanup and
environment teardown still apply.

Supervisor recovery inspects the original Docker exec and command scope without
repeating creation, start or input. Log recovery uses the protected worker's
read-only inode export (native worker protocol 4), allowing append progress while
ordinary bound-input export retains its original version check. The recovered
log must match its retained device/inode/mode. Host snapshots of observed log
bytes are fsynced before receipt/cursor acknowledgement, with a 256 MiB operational
bound; task services keep their task logs independently. Lost retention receipts
preserve unsettled bytes for inspection. A replaced/deleted task log cannot
replace previously retained host output. Terminal output completion requires
both proved scope cleanup and successful capture of the final log tail.

These mechanisms have disposable-host integration tests, including supervisor
SIGKILL, surviving service descendants and log replacement. Actual AgenC session
bootstrap, canonical checkpoint/recovery and the complete acceptance gates remain
required; the CLI container flag is not enabled yet.

## Protected filesystem worker

The worker starts on the daemon host, outside the task PID namespace. Its only
bootstrap channel is inherited fd 3, a private `SOCK_SEQPACKET` socket. The host
sends `AFS1` and exactly two `SCM_RIGHTS` descriptors: the pinned task root and
mount namespace. Before sending readiness, the worker joins only that mount
namespace, changes its root and cwd, closes namespace setup authority, and drops
capabilities other than DAC override/read-search and file ownership operations.
It sets `no_new_privs`, disables dumpability and installs a syscall allowlist
which excludes execution, process creation, signals, namespace changes and
mounting. The fixed AppArmor policy and installer qualification remain tracked
requirements in the implementation ledger.

Task path traversal uses `openat2` and held directory ancestry. Each component
is confined beneath its held parent and magic links are disabled. `..` pops
only captured task ancestors; absolute symlinks reset traversal to the pinned
task root. Relative reads never reconstruct a held directory from its former
pathname. Transaction guards additionally compare the current parent and target
identities before applying mutations through held descriptors.

The worker opens task entries as `O_PATH` and rejects special file types and
kernel pseudo-filesystems before I/O. To upgrade an admitted regular-file or
directory descriptor, it passes that descriptor back over its private channel.
The host checks type and filesystem, reopens exactly that descriptor using its
own `/proc/self/fd`, and returns the resulting descriptor. The worker retains
no host `/proc` directory or other host pathname authority after setup. No
task-supplied pathname is resolved by the host reopen service.

Worker request packets contain big-endian request ID and operation code followed
by bounded fields. Responses contain request ID, errno (zero for success), and
a `mutation_started` bit followed by data. Descriptor-reopen requests use errno
`0xffffffff` and exactly one descriptor; they never appear on the external host
RPC. Native packets are bounded at 128 KiB and ordinary data chunks at 64 KiB.
Content is staged into memfds, sealed against writes/growth/shrink, then used for
comparison and mutation. Per-content and total retained-content limits are
32 MiB and 128 MiB. Capability IDs do not repeat during a worker lifetime; the
supervisor adds an opaque worker epoch to prevent reuse across restarts or
authority changes. Another session's epoch cannot access those capabilities.

The private worker readiness protocol is version 9. A supervisor refuses a
different worker version during connection, before issuing any task mutation.
Path metadata supports explicit follow/no-follow symlink handling. Exact path
descriptions additionally return a revalidated canonical task path, link count,
and lossless identity/timestamps. The component walker constructs that path;
the worker neither changes cwd nor resolves a host path. A held-file description
rejects a pathname that no longer refers to its original descriptor. Timestamp
seconds and nanoseconds travel separately to avoid integer overflow. The
controller checks these identities around instruction and configuration reads.

`filesystem_bound_readlink` exposes bounded symlink bytes through the observed
entry's private descriptor. The controller checks exact path identity before and
after the read; the worker checks the held parent and named inode on both sides
of `readlinkat`. Replacement or a changed parent fails explicitly. This also
supports dangling links without following them or opening their targets. Older
hosts reject the operation before any capability acquisition. Permission path
resolution uses these reads to retain every intermediate symlink destination,
process `..` after preceding symlinks, and recheck observed entries before
returning. This observation does not replace the mutation's own descriptor guard.

`filesystem_recursive_guard` captures an absent ancestor and its remaining
components without creating anything. Only an admitted write creates missing
parents, exclusively through held directory descriptors, and syncs each parent.
A newly occupied component or exchanged parent fails explicitly. Capture receipts
include `missingParents`; the controller retains this evidence because restoring
only the final file cannot undo created directories. Any later failure preserves
the effect for review without automatic file rollback, even if inspection finds
no final file. The worker retains its mutation flag after the first directory
creation, including a later exclusive-create conflict. Readiness version 9 adds
this ancestor flag to the capture reply; older workers/hosts fail negotiation.

Directory capabilities bind the caller's verified parent identity and resolve
entry basenames without following the final symlink. Regular-file rename checks
the original inode, version and sealed expected bytes, then uses `renameat2`
with `RENAME_NOREPLACE`; it never overwrites an occupied destination. Symlink
removal checks the expected target bytes through the held symlink descriptor.

Deletion first moves the captured entry to a unique `.agenc-delete-…` name in
the same held parent. The worker verifies the moved inode before deleting it.
Recursive deletion walks held directories without following symlinks and bounds
depth and work. An error after relocation remains an explicit mutation failure;
the supervisor retains the original request, including its temporary name,
with the committed intent digest. Inspection verifies that digest and never
repeats the mutation. These operational receipts remain subordinate to AgenC's
canonical journal; canonical settlement and review integration are still tracked
in the implementation ledger.

The TypeScript bound-read adapter uses the held task descriptors for managed
ripgrep, including exact-file input. Structured record parsing shares the local
helper's fixed, repository-owned parser source. Only that shipped literal is
compiled in the controller; task output enters its bounded parser as bytes,
never as code or a workspace module. Limits, timeout and cancellation await
strict managed cleanup. Input chunks have distinct admitted operation indices;
uncertain input acknowledgement is not retried. Raw stdout can be spooled into
the caller's private controller temporary directory, independently of the
diagnostic byte budget. This output storage does not provide task workspace
filesystem authority. Actual tool callers still require environment migration.

## Qualification commands

`DockerExecutionEnvironment` combines process and protected-filesystem authority
for one immutable owner binding. `UnifiedExecProcessManager` delegates to
`EnvironmentProcessManager` when supplied that environment. This path uses
managed leases for shell and PTY execution, strict cleanup for kill/lifecycle
drains, and retained output cursors for polling. Model handles are numeric and
owner-scoped; listing does not drain output. Unknown launch/input outcomes close
owner admission without redispatching the original effect. Bootstrap/session
binding and durable model-handle restoration still require integration.

The environment manager uses native task logs and environment-owned scopes for
detached services, gated on the host's `detached_task_logs` capability. Other
task entrypoints still require migration before isolated
sessions can be enabled; the CLI does not yet expose the environment selector.

From the repository root:

```sh
python3 -B -m unittest discover -s runtime/tests/execution-host -v
npm run test --workspace=@tetsuo-ai/runtime -- tests/execution-host --reporter=dot
python3 -B runtime/tests/execution-host/run-kernel-probe.py \
  --worker-binary runtime/dist/agenc-filesystem-worker \
  --launcher-binary runtime/dist/agenc-task-launcher \
  --log-dir /tmp/agenc-execution-host-qualification
```

The last command creates and removes a disposable nested Docker daemon, with a
private cgroup namespace and no outer Docker socket mount. It uses pinned Docker,
runc and task images, preserves the outer daemon's runtime registration/default,
and collects operational receipts. It currently qualifies the disabled-AppArmor
task configuration. The complete repository kernel lane, standard AppArmor,
actual AgenC canonical journals and Harbor grading remain separate gates.
The runner also requires a supported Node executable and a real Linux ripgrep
binary runnable in the task image (a static executable is suitable). Both may
be selected explicitly with `--controller-node` and `--ripgrep-binary`. The
ripgrep version and binary digest are retained with the qualification evidence;
missing executables fail the probe rather than skipping search qualification.

Protected directory creation (`create_directory`, native operation 26) is an
exclusive `mkdirat` through a held directory descriptor. The controller checks
exact parent description before the admitted dispatch; the worker checks held
parent identity before and after creation and fsyncs the directory. Existing
leaves are never followed or accepted as successful creation. The operation is
journaled in the supervisor's filesystem effect receipts and cannot replay.
Modes contain only permission bits and use the worker's existing 0022 umask.
Older hosts reject this operation before dispatch through capability negotiation.
