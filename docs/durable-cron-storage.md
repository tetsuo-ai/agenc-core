# Durable cron storage

Durable cron storage now requires Linux with traversable directory descriptors
(`/proc/self/fd`). macOS, Windows, and Linux installations without this facility
fail closed with `descriptor-confined I/O is unsupported`; durable creation,
mutation, and gateway delivery are unavailable there. This is a compatibility
change. Session-only in-memory jobs do not require durable storage. There is no
pathname fallback: checks before and after an ordinary pathname write cannot
undo an overwrite redirected during the write.

The OS account home must already exist on a local filesystem accepted by the
SQLite lock security checks, even when `AGENC_HOME` is elsewhere. Unavailable
or unsafe cron storage does not prevent unrelated commands from using a valid
configured AgenC home. No code in this change creates or changes permissions
on the OS account home itself.

If OS account lookup fails, ordinary sandbox policies retain any previously
verified cron reservations. A process that first builds a policy without a
trusted OS identity keeps durable cron disabled until restart, even if account
lookup later recovers. `HOME` and `AGENC_HOME` never supply the missing authority.
The separate existing POSIX credential-account check still requires OS identity
when creating a new home context or broker; this change does not relax that check.

Unsafe or unsupported storage is reported by CronList as an error, by session
startup and active schedulers as `cron_storage_unavailable` warnings, and by
the gateway as a delivery-state diagnostic including the concrete cause.
Only missing or malformed task records retain the empty-list behavior. Failed
durable loads admit only the owning conversation's in-memory jobs; they do not
dispatch durable jobs. Later rescheduling can retry after storage is repaired.
Warnings from superseded scheduler scans are discarded. Session startup stays
silent on a platform without descriptor-confined I/O when the workspace has no
`.agenc/scheduled_tasks.json`: there is nothing to restore. A record that exists
there is still reported.

Stop **all older AgenC scheduler and gateway processes using a workspace before
upgrading its writers**, and do the same before rolling back. Old versions use
workspace-local SQLite locks. New versions use a different namespace and do not
contend with old versions; mixed-version operation is unsupported. The cron
JSON format is unchanged. Old project lock files are left untouched and are no
longer opened by the new scheduler.

The durable task and delivery-outbox records remain in
`<workspace>/.agenc/scheduled_tasks.json`. Reads and atomic replacement retain
opened workspace and `.agenc` directory descriptors through publication,
directory sync, and cleanup. A linked `.agenc` directory or a symlink/hardlink
task file is refused. Existing current-user-owned 755 directories and 644 files
remain supported when other users cannot write them. New task files use 600.
Concurrent edits may cause a transaction to fail; failure after publication
does not imply that the original task file is unchanged.

All task-transaction and 16 delivery-execution SQLite locks reside in
`<OS account home>/.agenc-cron-locks-v1/<workspace identity>/`. The OS account
home comes from the operating system, independent of `HOME`, `AGENC_HOME`,
session settings, and tool arguments. The workspace identity hashes its device
and inode so canonical aliases, renames, independent AgenC homes, and separate
processes coordinate on the same locks. Lock files retain the shared SQLite
implementation's ownership, single-link, ACL, local-filesystem, sentinel, and
crash-release checks.

The lock namespace is reserved from sandboxed model writes and ancestor
replacement, including additional filesystem grants and broker overrides.
Durable cron refuses a workspace that contains or is contained by this lock
namespace, and refuses redirected lock directories or linked lock files.
Explicit unsandboxed execution remains operator trust. These protections do
not claim resistance to a separate malicious native process running as the
same OS user or to an administrator changing the trusted OS-home namespace.

Lock directories persist to preserve their cross-process inode identity; they
must not be removed while any current scheduler or gateway uses the workspace.
