import fs from "node:fs";
import path from "node:path";

const ENTRY = "dist/agenc-namespace-init-entry";
const MARKER = Buffer.from("AGENC_NAMESPACE_INIT_ENTRY_V1\n");

function contains(parent: string, child: string): boolean {
  return parent === "/" || child === parent || child.startsWith(parent + "/");
}
function overlaps(left: string, right: string): boolean {
  return contains(left, right) || contains(right, left);
}
function canonical(file: string): string | undefined {
  try { return fs.realpathSync(file); } catch { return undefined; }
}
function identity(stat: fs.BigIntStats): string {
  return [stat.dev, stat.ino, stat.mode, stat.nlink, stat.uid, stat.gid,
    stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

/** Mirror the native broker's deliberately narrow grammar before dispatch.
 * The broker repeats these checks independently and inserts its own FD 6
 * mount. Neither the task nor this planner can supply that descriptor. */
export function admitsNamespaceInitMount(args: readonly string[], target: string): boolean {
  const parent = path.dirname(target);
  let pid = false, user = false, death = false, proc = false, readonly = false, readonlyRoot = false;
  let delimiter = -1;
  for (let i = 0; i < args.length;) {
    const arg = args[i++]!;
    if (arg === "--") { delimiter = i - 1; break; }
    if (arg === "--unshare-pid") { if (pid) return false; pid = true; continue; }
    if (arg === "--unshare-user") { if (user) return false; user = true; continue; }
    if (arg === "--die-with-parent") { if (death) return false; death = true; continue; }
    if (arg === "--new-session" || arg === "--unshare-net") continue;
    const bind = arg === "--bind" || arg === "--ro-bind" || arg === "--dev-bind";
    const symlink = arg === "--symlink";
    const mount = bind || symlink || ["--tmpfs", "--dev", "--proc", "--remount-ro", "--dir"].includes(arg);
    if (!mount && arg !== "--seccomp" && arg !== "--chdir") return false;
    const values = bind || symlink ? 2 : 1;
    if (values > args.length - i) return false;
    const source = args[i]!, dest = args[i + values - 1]!;
    i += values;
    if (!mount) continue;
    if (!path.isAbsolute(dest) || Buffer.byteLength(dest) >= 4096 ||
        path.normalize(dest) !== dest || (dest !== "/" && dest.endsWith("/"))) return false;
    const resolved = canonical(dest);
    if (resolved !== undefined && resolved !== dest &&
        (overlaps(dest, target) || overlaps(resolved, target))) return false;
    if (arg === "--proc" && dest === "/proc") proc = true;
    if (arg === "--ro-bind" && source === parent && dest === parent) {
      if (readonly) return false;
      readonly = true;
      continue;
    }
    // The unchanged launcher emits mkdir scaffolding even for directories
    // already exposed by the read-only root. It creates no mount or alias.
    if (arg === "--dir" && readonlyRoot && !readonly && dest !== target && contains(dest, target) && resolved === dest) {
      try { if (fs.statSync(dest).isDirectory()) continue; } catch { return false; }
    }
    if (overlaps(dest, target)) {
      if (readonly || arg !== "--ro-bind" || source !== "/" || dest !== "/") return false;
      readonlyRoot = true;
    }
    if (bind && arg !== "--ro-bind") {
      const resolvedSource = canonical(source);
      if (resolvedSource !== undefined && overlaps(resolvedSource, target)) return false;
    }
  }
  if (!pid || !user || !death || !proc || !readonly || delimiter < 0) return false;
  const command = args[delimiter + 1];
  if (command === undefined || !path.isAbsolute(command)) return false;
  try {
    const executable = fs.statSync(command, { bigint: true });
    const artifact = fs.statSync(target, { bigint: true });
    return executable.dev !== artifact.dev || executable.ino !== artifact.ino;
  } catch { return false; }
}

/** The location comes only from the trusted installed package. The manifest
 * must name the fixed reserved entry; accepting an arbitrary metadata path
 * would turn a packaging declaration into mount authority. */
export function prepareNamespaceInitArtifact(runtimeRoot: string, args: readonly string[]): {
  readonly target: string;
  readonly isCurrent: () => boolean;
} | undefined {
  const target = path.join(runtimeRoot, ENTRY);
  const manifest = path.join(runtimeRoot, "package.json");
  const fixedArgs = [...args];
  const snapshot = (): string => {
    if (canonical(runtimeRoot) !== runtimeRoot || canonical(target) !== target) throw new Error("aliased init artifact");
    const metadata = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string; agencNamespaceInitEntry?: string };
    if (metadata.name !== "@tetsuo-ai/runtime" || metadata.agencNamespaceInitEntry !== ENTRY) throw new Error("missing reserved init entry");
    const stat = fs.lstatSync(target, { bigint: true });
    if (!stat.isFile() || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n ||
        (stat.uid !== 0n && stat.uid !== BigInt(process.geteuid!())) || stat.size !== BigInt(MARKER.length)) {
      throw new Error("untrusted init placeholder");
    }
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const bytes = Buffer.alloc(MARKER.length + 1);
      if (identity(fs.fstatSync(fd, { bigint: true })) !== identity(stat) ||
          fs.readSync(fd, bytes, 0, bytes.length, 0) !== MARKER.length ||
          !bytes.subarray(0, MARKER.length).equals(MARKER)) throw new Error("invalid init placeholder");
    } finally { fs.closeSync(fd); }
    if (!admitsNamespaceInitMount(fixedArgs, target)) throw new Error("unsupported init mount layout");
    return identity(stat) + ":" + identity(fs.statSync(manifest, { bigint: true }));
  };
  try {
    const initial = snapshot();
    return { target, isCurrent: () => { try { return snapshot() === initial; } catch { return false; } } };
  } catch { return undefined; }
}
