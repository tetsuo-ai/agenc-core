# Workspace-scoped agent-role identity

Status: accepted and implemented on 2026-07-15.

## Decision

Agent-role lookup is bound to one immutable, absolute workspace identity for
the lifetime of a session. That identity is separate from the execution cwd,
which may move into a temporary Git worktree and back.

The contract is:

- `Session.roleWorkspace` is created once at session construction. Child,
  review, and compatibility sessions inherit the parent's identity.
- Role registry APIs require an `AgentRoleWorkspace`; there is no ambient cwd
  or process-global, most-recent-workspace fallback.
- Programmatic and Markdown role caches include the workspace ID. User-managed
  global roles remain intentionally discoverable in each workspace, while
  project roles remain scoped to their project identity.
- Bootstrap builds one canonical catalog from built-ins, workspace-scoped
  programmatic roles, plugins, and Markdown definitions. TUI, AgentTool,
  compatibility turns, and child/worktree sessions receive cloned views of
  that same catalog instead of independently rebuilding reduced fallbacks.
- The `spawn_agent` schema and the executing `AgentControl` must carry the same
  workspace ID. A mismatch is rejected before delegation or registry mutation.
- Spawn, preflight, resume, and restart use the control's immutable identity,
  never the session's mutable execution cwd.
- New child metadata persists `agentRoleWorkspaceId`. A named role cannot be
  resumed or restarted when that provenance is missing or belongs to another
  workspace. This check runs before a spawn slot or path is registered.
- The legacy AgentTool transcript sidecar carries the same immutable workspace
  ID. Missing, malformed, cross-workspace, or removed-role metadata is rejected
  before background-task registration; it never falls back to the default role.
  A complete sidecar is fsynced and atomically published before the task becomes
  visible or model work starts. Persistence failure aborts publication and
  removes any unpublished worktree.
- Persisted metadata is type-checked at both SQLite and legacy-snapshot ingress.
  A defined role must be a non-empty string; malformed values never collapse
  to the unrestricted default role.
- A defined daemon role-workspace field is validated as a complete absolute,
  self-consistent provenance envelope at create/restore ingress. Only total
  absence receives legacy handling; malformed presence never falls back to an
  execution cwd.
- The TUI snapshots the session workspace once and uses that same value for its
  initial state and live role picker.
- `/agents` file mutations require the same explicit catalog authority. They
  pin and revalidate trusted directories, reject symlinks and multiply-linked
  files, and atomically replace a regular file without changing its mode.
- CLI startup resolves a relative `AGENC_WORKSPACE` against the startup cwd. If
  that cwd is unavailable, the relative value is rejected; absolute rescue
  paths continue to work.

## Threat model

One daemon can serve sessions for repositories A and B. Both repositories may
define `.agenc/agents/reviewer.md`, with different prompts, tool restrictions,
models, or reasoning settings. A role name alone is therefore not an authority
or a globally unique key.

The prior fallback searched loaded namespaces in recency order. Loading B
after A could make an A spawn execute B's role. Recomputing scope from the live
cwd was also unsafe: entering a worktree changes execution location without
changing the role trust domain. Name-only rollout metadata had the same
confused-deputy risk during resume and restart.

## Boundary matrix

| Boundary | Enforced identity |
| --- | --- |
| Role discovery/cache | Immutable workspace ID in every lookup and cache key |
| Tool schema | Workspace captured when model-facing tools are assembled |
| Live spawn/preflight | `AgentControl.roleWorkspace` |
| Child/worktree session | Inherits parent role workspace; cwd may differ |
| Resume/restart | Persisted metadata ID must equal control workspace ID |
| TUI/AgentTool/nested catalogs | Cloned views of one canonical startup catalog |
| Pane teammate with a named role | Rejected until its process protocol can enforce the full exact-role envelope |

## Compatibility and failure behavior

Built-in roles and role aliases are unchanged. Existing project Markdown roles
continue to load from the same locations. The observable compatibility change
is deliberate: legacy open-child metadata with a named role but no workspace
provenance is not automatically rebound. The parent session remains usable;
the operator can explicitly spawn a fresh child in the current workspace.

This is fail-closed because silently reconstructing a missing custom role could
drop its prompt, allowlist, or denylist. Rollout parsing remains backward
compatible so old sessions can be inspected even when a named child cannot be
resumed automatically.

Agent memory and snapshot directories now use hashed, cross-platform path
components. An unambiguous legacy directory for a safe exact name (for example
`worker/`) is moved once to its hashed name after symlink and containment
checks. Lossy legacy names are never auto-adopted. In particular, the former
remote-local workspace namespace replaced path separators with `-`, so two
different workspaces could collide. AgenC does not automatically load or move
those ambiguous `$AGENC_REMOTE_MEMORY_DIR/projects/<legacy-key>/` directories;
an operator may inspect and copy trusted content into the newly reported
hashed directory after confirming its originating workspace. This is an
intentional security migration, not silent data deletion.

Role and memory files are accepted only as regular, single-link files below an
explicit tier/workspace trust anchor. Symlinked roots, directory entries, and
files are rejected. Reads pin one descriptor and verify device/inode identity,
canonical containment, and pre/post state. Snapshot writes and deletes pin the
trusted directory identity and use descriptor-relative paths where the host
exposes `/proc/self/fd` or `/dev/fd`, with deterministic directory-swap tests.
Hard-linked files are rejected because a second pathname would otherwise let
content escape the reviewed namespace.

The remaining filesystem boundary is explicit: privileged bind-mount
replacement is outside the unprivileged repository threat model. Node does not
expose portable `openat2`/`unlinkat`; on hosts without usable descriptor paths,
a hostile same-user process continuously racing the final pathname syscall is
also outside the guaranteed boundary. AgenC still revalidates before and after
the operation and fails closed for observable swaps. Operators needing
protection from a mutually hostile same-UID process must isolate it by OS user
or sandbox rather than sharing the daemon's filesystem authority.

Agent-definition fingerprints hash the immutable role prompt and executable
policy, not memory text appended at turn time. An authorized agent can update
its own memory without making its persisted role provenance unresumable; a
base-prompt, model, tool, or permission change still invalidates provenance.

State schema v12 also copies `agentRoleWorkspaceId` into a dedicated
`thread_spawn_edges.agent_role_workspace_id` column. The migration backfills
existing JSON metadata, and legacy field-list rewrites cannot erase the
column or rebind a child to another role/workspace pair. Rollout reads and
state transitions consult SQLite rather than a stale process cache; closing an
open edge is one compare-and-swap transition, repeated close is idempotent, and
reopening a closed edge is rejected. Before v12 is committed, AgenC
holds a SQLite writer reservation, refreshes and verifies a consistent v11
snapshot, fsyncs it as `agenc-state_1.pre-v12.sqlite` beside the live database,
and commits the migration without releasing that reservation. This makes the
backup correspond to the exact pre-migration state even if an older daemon was
still running or an earlier migration attempt left a stale backup.

The schema guard makes older runtimes refuse a v12 database instead of silently
downgrading it. To roll back, stop the daemon **and every other process with an
open connection**, then preserve `agenc-state_1.sqlite` together with its
`agenc-state_1.sqlite-wal` and `agenc-state_1.sqlite-shm` sidecars as one
forensic set. Committed transactions may exist only in the WAL; never delete or
separate those files from the preserved database. In the now-idle project
directory, move the complete v12 set out of the live filenames, copy
`agenc-state_1.pre-v12.sqlite` to `agenc-state_1.sqlite`, and only then start the
older runtime. Never open the migrated database with the older binary.

## Alternatives rejected

- Keep a process-global registry: role-name collisions remain cross-workspace.
- Pass cwd only at selected callers: a new caller can silently omit it.
- Use the live execution cwd: worktree entry changes authority mid-session.
- Persist only the role name: restart cannot prove the originating workspace.
- Bind legacy named metadata to the current workspace: this recreates the
  confused-deputy behavior at the recovery boundary.

## Verification

Revert-sensitive coverage includes:

- two workspaces defining the same Markdown and programmatic role names;
- a real model-facing spawn executed after its session cwd moves elsewhere;
- an explicit tool-catalog/session workspace mismatch that never delegates;
- aligned and cross-workspace resume metadata, plus missing legacy provenance;
- malformed persisted role values failing before registry mutation;
- provenance round-trip through durable thread-spawn edges;
- migration backfill, immutable provenance, and same-process recovery after a
  legacy JSON metadata rewrite;
- exact-boundary pre-v12 backup refresh and restoration under the v11 schema;
- AgentTool sidecar resume rejecting missing, removed, and cross-workspace roles;
- attach rejecting malformed-but-present provenance instead of substituting cwd;
- task publication waiting for a complete, atomic, durable role sidecar;
- stable session role identity while entering and leaving a worktree; and
- TUI, AgentTool, compatibility, and nested child sessions receiving the same
  canonical catalog, including workspace-scoped programmatic roles;
- simple mode retaining workspace-scoped programmatic roles in that catalog;
- malformed daemon provenance failing at create/restore before session state;
- exact-role pane spawns failing before pane/backend mutation;
- SQLite-authoritative rollout reads and open-to-closed compare-and-swap races;
- role-loader file/directory symlink, hardlink, and validation-to-open swaps;
- `/agents` create/update/delete confinement, mode preservation, and symlink,
  hardlink, traversal, and directory-swap rejection;
- snapshot validation-to-write/delete directory swaps with no external
  mutation; and
- agent memory updates preserving resumability while base-role changes fail,
  with foreign, sibling, unauthenticated, and hard-linked memory paths denied
  before general working-directory allowances.

## Research basis

Research was refreshed on 2026-07-15 from primary sources:

- The [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
  recommends establishing tenant context early, propagating it through every
  layer, including it in lookup keys, and rejecting access without context.
  Workspace identity is the analogous isolation key here.
- The implementation also keeps routing and execution location separate from
  authority: a worktree cwd can change while the early-bound workspace tenant
  key, prompt identity, and tool policy remain immutable.
