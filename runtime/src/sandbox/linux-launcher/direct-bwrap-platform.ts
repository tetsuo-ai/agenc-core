// Keep the launcher entry module isolated: importing linux-run-main into the
// daemon would move its import.meta.url into a shared bundle chunk and change
// defaultSelfCommand() for the legacy path. Differential tests cover these
// bounded platform checks against that unchanged implementation.
import fs from "node:fs";
import path from "node:path";

const ELF_MACHINE: Partial<Record<NodeJS.Architecture, number>> = {
  arm: 40,
  arm64: 183,
  ia32: 3,
  loong64: 258,
  ppc64: 21,
  riscv64: 243,
  s390x: 22,
  x64: 62,
};
const ELF_64_BIT_ARCHES = new Set<NodeJS.Architecture>([
  "arm64",
  "loong64",
  "ppc64",
  "riscv64",
  "s390x",
  "x64",
]);

/**
 * Whether `file` is a regular file starting with an ELF header for this
 * machine's architecture and word size, so the kernel runs it rather than
 * refusing it with ENOEXEC. The open never blocks: a FIFO or device is
 * opened nonblocking and rejected before any read.
 */
export function isNativeElfExecutable(
  file: string,
  arch: NodeJS.Architecture = process.arch,
): boolean {
  const machine = ELF_MACHINE[arch];
  if (machine === undefined) return false;
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
    if (!fs.fstatSync(fd).isFile()) return false;
    const header = Buffer.alloc(20);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length) return false;
    if (header.readUInt32BE(0) !== 0x7f454c46) return false;
    const wordSize = ELF_64_BIT_ARCHES.has(arch) ? 2 : 1;
    if (header[4] !== wordSize) return false;
    const encoding = header[5];
    if (encoding !== 1 && encoding !== 2) return false;
    const eMachine = encoding === 1 ? header.readUInt16LE(18) : header.readUInt16BE(18);
    return eMachine === machine;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function resolveSandboxDeviceBinds(
  env: NodeJS.ProcessEnv,
): readonly string[] {
  const raw = env.AGENC_SANDBOX_DEVICE_BINDS;
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  const seen = new Set<string>();
  const resolved: string[] = [];
  const accept = (candidatePath: string): void => {
    if (seen.has(candidatePath)) return;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(candidatePath);
    } catch {
      return;
    }
    if (!stats.isCharacterDevice() && !stats.isBlockDevice()) return;
    seen.add(candidatePath);
    resolved.push(candidatePath);
  };
  for (const entry of raw.split(":")) {
    const candidate = entry.trim();
    if (candidate.length === 0) continue;
    if (!path.isAbsolute(candidate)) continue;
    const normalized = path.normalize(candidate);
    if (normalized.split(path.sep).includes("..")) continue;
    if (!normalized.startsWith("/dev/")) continue;
    if (!normalized.includes("*")) {
      accept(normalized);
      continue;
    }
    // Pattern entry, e.g. /dev/ttyUSB* — one setting covers every board the
    // user plugs in, now and later, instead of a path per device. Expanded at
    // every sandbox launch, so a board connected mid-session is picked up by
    // the next command with no reconfiguration. `*` matches within one path
    // segment only; a pattern spanning directories is rejected outright.
    const dir = path.dirname(normalized);
    const base = path.basename(normalized);
    if (dir.includes("*") || dir !== path.normalize(dir)) continue;
    if (!dir.startsWith("/dev")) continue;
    const matcher = new RegExp(
      `^${base.split("*").map(escapeRegExpLiteral).join("[^/]*")}$`,
      "u",
    );
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names.sort()) {
      if (matcher.test(name)) accept(path.join(dir, name));
    }
  }
  return resolved;
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
