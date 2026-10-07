import { createHash } from "node:crypto";
import fs from "node:fs";
import { sanitizeSandboxLauncherEnvironment } from "../launcher-environment.js";

/** A successful probe is a hint to TRY the same confinement, never to omit it. */
export interface BubblewrapCapabilityHint {
  readonly context: string;
  readonly supportsArgv0: boolean;
  readonly supportsBindFd: boolean;
  readonly procArgs: string;
}

export function capabilityDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function bubblewrapCapabilityContext(
  program: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    const executable = fs.statSync(program, { bigint: true });
    const directory = fs.statSync(cwd, { bigint: true });
    if (!executable.isFile() || !directory.isDirectory()) return undefined;
    const sanitized = sanitizeSandboxLauncherEnvironment(env);
    return capabilityDigest({
      program: fs.realpathSync(program),
      executable: [executable.dev, executable.ino, executable.size, executable.mode,
        executable.uid, executable.gid, executable.mtimeNs, executable.ctimeNs].map(String),
      cwd: [fs.realpathSync(cwd), String(directory.dev), String(directory.ino)],
      environment: Object.keys(sanitized).sort().map(key => [key, sanitized[key]]),
      uid: process.getuid?.(), gid: process.getgid?.(), groups: process.getgroups?.(),
      namespaces: ["user", "mnt", "net"].map(name => fs.readlinkSync(`/proc/self/ns/${name}`)),
      mounts: fs.readFileSync("/proc/self/mountinfo", "utf8"),
    });
  } catch {
    return undefined;
  }
}

export function parseBubblewrapCapabilityHint(value: string): BubblewrapCapabilityHint | undefined {
  if (value.length > 1024) return undefined;
  try {
    const x: unknown = JSON.parse(value);
    if (x === null || typeof x !== "object") return undefined;
    const h = x as Partial<BubblewrapCapabilityHint>;
    if (typeof h.context !== "string" || !/^[a-f0-9]{64}$/.test(h.context) ||
        typeof h.procArgs !== "string" || !/^[a-f0-9]{64}$/.test(h.procArgs) ||
        typeof h.supportsArgv0 !== "boolean" || typeof h.supportsBindFd !== "boolean") return undefined;
    return { context: h.context, procArgs: h.procArgs,
      supportsArgv0: h.supportsArgv0, supportsBindFd: h.supportsBindFd };
  } catch { return undefined; }
}
