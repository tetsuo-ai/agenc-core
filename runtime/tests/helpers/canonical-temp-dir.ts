import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";

/**
 * The OS temp directory with every symlink resolved.
 *
 * AgenC resolves homes and session cwds to their real path, and it refuses to
 * resume from a cwd that is not canonical. On macOS the default temp
 * directory (`/var/folders/...`) and `/tmp` both sit behind a symlink into
 * `/private`, so a path built from the raw `tmpdir()` comes back rewritten or
 * gets rejected there, while the same test passes on Linux. Build test paths
 * from this instead. On Linux it returns the same path as `tmpdir()`.
 */
export function canonicalTmpdir(): string {
  return realpathSync(tmpdir());
}
