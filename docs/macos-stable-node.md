# Stable Node on macOS

Standalone installs and the published npm launcher run AgenC through
`<AGENC_HOME>/bin/agenc-node` on macOS. This is a regular copy of the release's
private Node executable. A sibling `node` symlink resolves to `agenc-node` so
child commands found through PATH use that same executable. JavaScript, native
addons, licenses, and other runtime files remain in the versioned runtime tree.
Development checkouts, Homebrew-managed installations, Linux, and Windows keep
their existing launch behavior. Runtime pruning is macOS-only in this change.

## Why this should retain privacy grants

The reported repeated Documents, Desktop, and Downloads prompts followed a new
per-version Node executable path after every AgenC update. For a command-line
client, a stable canonical executable path avoids changing that part of its
TCC identity. Preserving the official binary bytes also preserves its signing
identifier and designated requirement. Apple's explanation of designated
requirements describes how macOS recognizes an updated program when evaluating
an existing privacy authorization:
[Inside Code Signing: Requirements](https://developer.apple.com/documentation/technotes/tn3127-inside-code-signing-requirements).

The expected result is reuse of the authorization when the updated Node still
satisfies the recorded requirement. The signer remaining the same is necessary
but the whole designated requirement must remain compatible. The official
binaries tested identify as `node`, signed by Node.js Foundation, team
`HX7739G8FX`. No binary is patched, stripped, or re-signed, and no TCC database,
privacy setting, or Full Disk Access grant is changed.

This is engineering reasoning supported by signature and path tests, not a
claim that the macOS dialogs have been verified. Initial migration to the new
path can require one new grant per protected folder. Terminal attribution and
existing privacy state can also affect what the user sees.

## Activation and recovery

The existing archive checksum, byte limits, provenance verification, extraction
validation, and private-Node identity probe run before standalone activation.
The stable copy additionally checks the extracted executable's size and SHA-256
against `identity.json`, the content-addressed directory, and its ready marker.
It writes a private sibling temporary file, verifies the copy, flushes it,
renames it over `agenc-node`, and flushes the parent directory. A running process
keeps its old executable mapping. Identical Node bytes do not cause a replacement.

The home activation lock covers Node replacement, wrapper activation, and
activation history. Its durable journal records the source and executable hash
before replacement. A retry through either the installer or updater verifies
and completes the pending Node and wrapper activation before starting another.
Dead-process temporary Node copies are cleaned on retry. The two-file cutover
uses the existing roll-forward policy; a crash can leave new Node bytes with
old wrapper contents until retry. Supported private-Node releases currently
use Node 26 and ABI 147. Existing processes are never restarted by this change.

`update --pin` still permits a downgrade and copies the pinned release's Node
back to the same path. Unpinned downgrade prevention happens before replacement.
The wrapper grammar is unchanged so older pinned updaters can still recognize
it. Running an updater from a release that predates this feature can restore
that older updater's per-version launch behavior on a later update.

The launchd plist continues to name the installed `agenc` wrapper. Its exec now
lands at the stable executable. Daemon, gateway, background-agent, and other
AgenC child launches using `process.execPath` inherit that identity.

## Runtime retention

After successful standalone or npm version activation, cleanup retains the current version,
the preceding active version, and any older version referenced by process
command lines or open files, executable mappings, native addons, or cwd.
A failed or incomplete process inventory defers cleanup. The updater prints
removed-tree count and logical bytes freed; JSON output includes `pruning`.

A home maintenance lock serializes cleanup with update-lease registration.
Leases span download, verification, extraction, and activation. Cleanup does
not run while another lease's process is alive. Dead leases from killed
updaters are reclaimed. Activation journals, interrupted extraction or backup
residue, and recognizable older updater processes also defer cleanup.

Only recognized, marked content-addressed trees are removed. Symlinked versions
and unrecognized trees are preserved. Persistent SQLite lock files and their
small version directories remain to avoid changing lock identity. Each removal
has a durable journal, so retry can finish an interrupted removal even after
its ready marker has already been deleted. Retention and process usage are
checked again on recovery and immediately before removal.

Before deletion, a candidate is atomically moved to a private quarantine path
and process usage is scanned again. A process that started at the original
path before that rename causes the tree to be restored. New launches at the
obsolete original path cannot enter the tree chosen for deletion. The removal
journal also recovers crashes before or after this quarantine rename.

The measured macOS arm64 0.19.15 artifact contains 419,906,042 regular-file bytes
(400.5 MiB), including a 147,346,352-byte Node executable (140.5 MiB). A home with
one comparable runtime for every version from 0.19.6 through 0.19.15 can remove
eight trees while keeping two: approximately 3.13 GiB gross, or 2.99 GiB net
after adding the stable Node copy. This is an estimate from the released
archive, not a measurement of the owner's home. Actual disk blocks, retained
running versions, and different release sizes change the result.

## Manual privacy check

1. Use an isolated macOS test account or VM and releases containing this change.
   Start sessions whose working directories are in Documents, Desktop, and
   Downloads. Record the initial migration prompts separately and grant access
   through the normal dialogs.
2. Verify that the installed wrapper names `<AGENC_HOME>/bin/agenc-node` and that
   `codesign --verify --strict` succeeds for that file. Record its designated
   requirement with `codesign -d -r-` and verify it remains compatible after each
   update.
3. Update once, restart the test daemon, reopen all three sessions, and count
   prompts for each folder. Record the installed release and Node versions.
4. Update a second time, restart and reopen the same sessions, and count again.
   The expected count after the initial migration is zero on both updates.
   Record actual counts, including any denials or attribution to another app.
5. Keep an older test daemon running during a further update. Confirm its
   runtime remains present. After it exits, a later successful update may prune
   that tree. Pin the previous release and verify it starts through the same
   stable executable path.

No dialog interaction is automated by the tests.
