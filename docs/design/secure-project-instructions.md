# Secure live project instructions

Status: implemented. Research and threat model reviewed 2026-07-16.

## Live request contract

Every coding-agent turn resolves instructions from the turn's effective `cwd`
at the shared session/run-turn boundary. This covers daemon-backed interactive,
print, SDK/background, gateway, cron/heartbeat, resumed, child/worktree,
workflow, and review turns. A worktree child resolves its own workspace; it
never inherits a rendered parent-workspace prompt.

The mechanically enforced file precedence, from lower to higher precedence, is:

1. managed system files and managed rules;
2. user-global `$AGENC_HOME/AGENC.md` (or the explicit config home) and user
   rules;
3. project files from root to `cwd`, with per-directory order
   `AGENC.override.md`, `AGENC.md` (or `AGENTS.md` fallback),
   `.agenc/AGENC.md`, then `.agenc/rules/**/*.md`;
4. project-root `AGENC.local.md`.

The resolved workspace block is framed as repository guidance. Repository
agent-role text is separately framed at the same untrusted authority, while
trusted internal review guidance and the core runtime base follow it. A role
file cannot replace the core base. Project/local text cannot grant a
capability, approve a mutation, weaken permission/sandbox/network/budget
policy, expose credentials, or override system/developer/user authority.
Runtime policy enforcement remains authoritative even if a file asks the model
to ignore that boundary.

Explicit source controls remain authoritative: the hard-off environment flag,
bare mode, configured setting sources, and relocated config home are applied by
the same live resolver before any tier is loaded. Hard-off and bare mode also
skip instruction-file and root-marker cache probes, so disabled sources do not
cause even metadata reads.

One owner sends the envelope: `TurnState.modelInstructions` remains outside
conversation history and provider adapters receive it once through their native
`systemPrompt` option. Leading durable/compatibility system-shaped history is
framed as untrusted persisted context before the current core base, folded into
that field, and removed from provider input. Retries and compact/recovery
iterations reuse the immutable turn envelope rather than appending another
copy.

Specialized non-agentic model calls are intentionally isolated: compaction,
MCP server sampling, web/search extraction, permission classifiers, memory
selection/summarization, shell-prefix helpers, and realtime voice. They use
purpose-specific prompts and do not acquire repository instruction authority.

## Descriptor-bound filesystem contract

`readInstructionFileSnapshot()` is the common reader for entrypoints,
fallbacks, overrides, `.agenc/AGENC.md`, rules, and recursive includes. It:

- pins lexical and canonical tier/workspace boundaries;
- rejects broken links, symlink components below the boundary, non-regular
  files, repository hard links (`nlink != 1`), invalid UTF-8, and oversized
  content;
- opens with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` where Node exposes them, so
  a regular-file-to-FIFO replacement cannot hang the daemon;
- compares pathname `lstat` identity to opened-handle `fstat` identity;
- reads only from that handle, then rechecks handle/path identity, size,
  link-count, mtime, ctime, and canonical path;
- hashes the exact captured bytes and assembles only that immutable snapshot;
- invalidates the cache from full file identity plus every included file,
  rule file, rule directory, fallback, override, and negative candidate.

Resolution has shared, validated resource ceilings: 5 MiB and 512 references
for includes, 5 MiB for the final workspace envelope, and a bounded rule walk
(2,000 entries, 256 directories, 200 opened files, and 512 KiB). Exceeding a
ceiling rejects the remainder instead of allowing one tier or ancestor to reset
the budget. Cache-fill pre/post snapshots prevent a stale-safe entry from being
published during concurrent mutation.

An unapproved external include is discovered using path and identity metadata
without opening its content stream. Exact target evidence stays in local
operator warnings/audit state; model-visible rejection markers never reveal a
canonical host path or target identity. Rejections also emit a deduplicated
local session warning so daemon/TUI operators retain actionable evidence. The
default live path has no approval
store, so interactive and unattended execution both deny it.

An embedding host may provide a process-local trusted-operator approval store.
Each grant binds one workspace, including canonical source path and source
digest, canonical target path and target identity, principal, and optional
expiry. Stored grants and identities are immutable, use is audited, and grants
are revalidated immediately before the first byte read. No repository/config
field can create or broaden a grant. The removed
blanket external-include boolean is intentionally not migrated as authority.

## Threat model and platform limits

Hard links cannot be distinguished from their original name by canonical-path
checks, so project files and external targets are rejected when `nlink != 1`.
This prevents the ordinary hard-link-to-secret attack. A privileged actor that
can create/remove aliases during the open remains outside the repository-only
attacker model; the opened identity and pre/post link-count checks still make
normal races fail closed.

An opened descriptor survives rename/unlink without changing identity, but it
does not freeze an inode. Pre/post `fstat`, exact byte count, and digest detect
ordinary concurrent writes. An actor able to modify bytes and restore all
observable metadata precisely is treated as host-compromised. Project content
therefore remains non-authoritative even after a valid snapshot.

Pure Node does not expose Linux `openat2(2)` resolution flags or `statx` mount
IDs. It cannot prove absence of same-device bind mounts. The isolation boundary
is the daemon's OS sandbox/mount namespace; hardened deployments should deny
untrusted mounts there. A future native hardened reader may use
`RESOLVE_BENEATH | RESOLVE_NO_MAGICLINKS | RESOLVE_NO_SYMLINKS`, optionally
`RESOLVE_NO_XDEV`. On macOS the portable handle-bound checks are the available
baseline. On Windows, Node lacks an atomic `CreateFileW` + handle-final-path +
`FILE_ID_INFO` traversal API; reparse-point containment depends on the OS
sandbox, and junction/reparse coverage remains a platform-gated test target.

## Research record

Primary sources reviewed 2026-07-16:

- [Node.js 25 filesystem API](https://nodejs.org/docs/latest-v25.x/api/fs.html)
- [Linux `openat2(2)`](https://man7.org/linux/man-pages/man2/openat2.2.html)
- [Linux `open(2)` / `O_NOFOLLOW`](https://man7.org/linux/man-pages/man2/open.2.html)
- [Linux symlink and hard-link semantics](https://man7.org/linux/man-pages/man7/symlink.7.html)
- [POSIX `open`/`openat`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/open.html)
- [Apple `stat`/`fstat`](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/stat.2.html)
- [Microsoft `CreateFileW`](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Microsoft handle final paths](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getfinalpathnamebyhandlew)
- [Microsoft `FILE_ID_INFO`](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_id_info)
- [OpenAI Model Spec authority rules](https://model-spec.openai.com/2025-12-18.html)
- [MCP tools trust guidance](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)

Rejected alternatives were pathname `realpath`/`stat` followed by `readFile`,
`O_NOFOLLOW` alone, path-only audit records, broad persistent approval, and
advisory locks as a security boundary. A mandatory native helper was deferred
because the descriptor-bound Node baseline closes the current leaks without a
new packaging dependency; the unsupported bind-mount assurance is stated
explicitly rather than overstated.

Rollback is one focused revert: no on-disk instruction format changed. The only
intentional compatibility breaks are rejection of symlink/hard-link instruction
files and removal of blanket external approval. Operators must replace aliases
with regular files; embedding hosts must use an exact trusted approval channel.
