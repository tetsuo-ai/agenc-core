import { createHash, randomBytes } from "node:crypto";
import { linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export function normalizePromptCacheKey(key: string): string {
  // Preserve existing cache routing unless the key exceeds the wire limit.
  return key.length <= 64
    ? key
    : createHash("sha256").update(key).digest("hex");
}

/** File in the AgenC home that holds the home's prompt-cache scope id. */
export const PROMPT_CACHE_SCOPE_FILE = "prompt-cache-scope";

const SCOPE_ID = /^[0-9a-f]{32}$/u;

type ScopeFile = { readonly id: string } | "missing" | "malformed" | "unreadable";

function readScopeFile(path: string): ScopeFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unreadable";
  }
  const id = text.trim();
  return SCOPE_ID.test(id) ? { id } : "malformed";
}

/**
 * The prompt-cache scope of one AgenC home: 128 random bits generated once,
 * kept in `<home>/prompt-cache-scope` (mode 0600) and reused by every later
 * session of that home, sent as `agenc-<32 hex>`. Separate homes (users) get
 * separate scopes, so the provider keeps separate cache accounting per user as
 * its guide asks, without separating one user's sessions from each other. The
 * id is random, so it carries nothing about the path or the user.
 *
 * The file appears atomically with its full content (a private temporary file
 * linked or renamed into place) and is regenerated only when it is missing or
 * malformed; an existing file that cannot be read is left alone. Returns
 * undefined when there is no usable id; the caller then keeps the conversation
 * key.
 */
export function promptCacheScopeKeyForHome(agencHome: string): string | undefined {
  const path = join(resolve(agencHome), PROMPT_CACHE_SCOPE_FILE);
  let file = readScopeFile(path);
  if (file === "missing" || file === "malformed") {
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(temporary, `${randomBytes(16).toString("hex")}\n`, { mode: 0o600, flag: "wx" });
      if (file === "missing") {
        try {
          linkSync(temporary, path);
        } catch (error) {
          // EEXIST: another session created the file first; keep it unless it
          // is malformed. Any other code: no hard links here, so move the
          // temporary file into place while the id is still missing.
          const current = readScopeFile(path);
          if ((error as NodeJS.ErrnoException).code === "EEXIST" ? current === "malformed" : current === "missing") {
            renameSync(temporary, path);
          }
        }
      } else {
        renameSync(temporary, path);
      }
    } catch {
      // The home cannot hold the file: no scope.
    } finally {
      try {
        unlinkSync(temporary);
      } catch {
        // Already renamed into place, or never written.
      }
    }
    file = readScopeFile(path);
  }
  return typeof file === "object" ? `agenc-${file.id}` : undefined;
}
