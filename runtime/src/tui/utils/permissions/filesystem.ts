// Cherry-picked relativePath helper for the wholesale-ported search
// dialogs.
//
// openclaude src/utils/permissions/filesystem.ts (~1787 LOC) is the
// permissions-allowlist matcher (path-glob → permission decisions).
// AgenC has its own permissions layer at runtime/src/permissions/.
// The wholesale-ported search dialogs only consume relativePath()
// from the openclaude file, so this shim provides just that helper
// using node:path.

import { relative as nodeRelative } from "node:path";

export function relativePath(from: string, to: string): string {
  return nodeRelative(from, to);
}
