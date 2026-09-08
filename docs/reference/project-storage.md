# Project storage keys

Project-scoped storage uses `v2-<readable-prefix>-<sha256>` directory keys.
Every key includes the full SHA-256 digest of the canonical project path and
its path platform. The readable prefix contains at most 64 ASCII characters;
the whole directory component is at most 132 bytes.

Sessions, rollouts, project tasks, memory, extraction, cache logs and temporary
files use `runtime/src/utils/project-storage-key.ts`. Each caller still chooses
its root according to its existing rules, such as the configured project-root
markers or the main repository behind linked worktrees. Generic session IDs
and MCP server labels are not project paths.

## Canonical paths

Native paths resolve relative references and existing symlinks. For a missing
descendant, the nearest resolvable ancestor supplies the canonical prefix.
If filesystem resolution is unavailable for another reason, the absolute
lexical path is used. A path that later becomes resolvable may receive a new
key, so existing roots are preferable to speculative paths.

Case and Unicode spelling are preserved unless filesystem resolution returns
the same canonical spelling. AgenC does not apply Unicode NFC folding to
project roots: two distinct directories on a case-sensitive filesystem must
not share retained context. Native Windows paths use Windows path rules.
Drive letters and slash variants in drive-absolute Windows paths normalize
consistently. Runtime callers always use native path rules: backslashes in a
POSIX filename remain literal characters. The helper also accepts an explicit
path platform for portable callers and contract tests. Explicit-platform mode
requires absolute paths and normalizes them lexically without filesystem
probes, even when the selected platform matches the host. Runtime storage
callers omit that option so existing filesystem aliases share an identity.
Node and Bun use the same digest algorithm and key format.

## Existing data and upgrades

Old directory names can represent multiple unrelated projects. This includes
the lossy punctuation-based names and the older rollout/task slugs with
eight-hex-character suffixes. AgenC does not move, delete or automatically
import those directories into the new layout.

Project-scoped listing and automatic continuation read exact v2 keys only.
They do not scan for matching readable prefixes. Existing explicit memory
directory overrides remain operator-selected paths.

To recover older work:

1. Stop existing daemons and back up the AgenC state home before changing data.
2. Restart all writers on the same version. Do not mix old and new writers.
3. Select a known legacy session explicitly with `agenc --resume <session-id>`
   or its rollout path. When no current-project v2 record matches, the existing
   bounded global lookup can find old rollouts. It verifies the recorded
   canonical working directory; an ambiguous match still requires an exact
   selection. A current-project v2 record takes priority over an old directory.
4. Recover memory or tasks only after identifying the owning project from
   their content or independent records. Copy reviewed items individually.
   Never copy an entire directory based only on its old name. Cache and temp
   directories can be regenerated instead.

Portable JSONL session APIs also retain explicit all-project lookup. An old
record found without a project filter does not acquire a project identity
from its directory name.

For rollback, stop the new writers and restore the previous runtime. Its old
directories remain intact. The previous runtime does not automatically read
v2 state, and rolling back restores its original collision risk.
