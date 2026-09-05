import { execFile } from "node:child_process";
import { lstat } from "node:fs/promises";
import { promisify } from "node:util";
import { sha256Digest } from "./canonical-json.js";
import type {
  EvidenceArtifactKind,
  PlatformProtectionVerifier,
} from "./evidence-ledger.js";

const execFileAsync = promisify(execFile);

/**
 * Identifies this verifier in ledger metadata. The ledger records the digest
 * of the verifier that ran, so a reader knows which check protected the
 * evidence; bump the suffix when the check changes.
 */
export const DARWIN_PLATFORM_PROTECTION_VERIFIER_ID =
  "agenc.platform-protection.darwin/v1";

/**
 * The evidence ledger keeps its own owner and mode checks, but mode bits do
 * not tell the whole story on macOS: an access control list can grant another
 * user read access to a 0700 directory or a 0600 file. This verifier reads
 * the ACL through `ls -led`, the only stable interface macOS offers for it,
 * and accepts an artifact only when it is a real file or directory, owned by
 * this user, closed to group and others, and carries no ACL entries at all.
 * Without a verifier the ledger refuses to run on macOS, which made every
 * goal run fail at intake on a Mac.
 */
export function createDarwinPlatformProtectionVerifier(
  options: { readonly listCommand?: string } = {},
): PlatformProtectionVerifier {
  const listCommand = options.listCommand ?? "/bin/ls";
  return {
    verifierDigest: sha256Digest(DARWIN_PLATFORM_PROTECTION_VERIFIER_ID),
    async verify(path: string, kind: EvidenceArtifactKind): Promise<boolean> {
      const stat = await lstat(path).catch(() => null);
      if (stat === null || stat.isSymbolicLink()) return false;
      if (kind === "directory" ? !stat.isDirectory() : !stat.isFile()) {
        return false;
      }
      if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
        return false;
      }
      if ((stat.mode & 0o077) !== 0) return false;
      return !(await hasAclEntries(listCommand, path));
    },
  };
}

/** `ls -led` prints the entry line, then one indented ` N: ...` line per ACL entry. */
async function hasAclEntries(listCommand: string, path: string): Promise<boolean> {
  const { stdout } = await execFileAsync(listCommand, ["-led", "--", path], {
    encoding: "utf8",
    maxBuffer: 64 * 1024,
  });
  return stdout
    .split("\n")
    .slice(1)
    .some((line) => /^\s+\d+:\s/.test(line));
}

/** The verifier for the running platform, or undefined where the ledger needs none. */
export function createPlatformProtectionVerifier(): PlatformProtectionVerifier | undefined {
  if (process.platform === "darwin") return createDarwinPlatformProtectionVerifier();
  return undefined;
}
