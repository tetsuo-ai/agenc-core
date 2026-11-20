/**
 * Deterministic `Git branch:` value for the system prompt.
 *
 * The prompt used to run `git rev-parse --abbrev-ref HEAD` in a sandboxed
 * spawnSync with a 1 s timeout. Under load that spawn timed out, the prompt
 * said `<not a git repository>` and its bytes changed. This reader gets the
 * same answer from the repository files: no subprocess, no 1 s event-loop
 * block, and nothing a repository config names is ever executed. It mirrors
 * git 2.53 run with GIT_* removed and no global or system config. Layouts it
 * does not model (reftable, unknown extensions, config that changes ref
 * lookup) are `unsupported`, so the caller can still ask git.
 */
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  type Stats,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export type GitHeadBranchRead =
  | { readonly kind: "branch"; readonly name: string } // exactly what `git rev-parse --abbrev-ref HEAD` prints
  | { readonly kind: "none" } // git would fail: not a repository, unborn branch, unreadable, not owned
  | { readonly kind: "unsupported" }; // a ref storage this reader does not parse (reftable): the caller asks git

interface Repository {
  readonly gitDir: string; // HEAD and per-worktree refs
  readonly commonDir: string; // shared refs, packed-refs and config
  readonly oidLength: number; // hex digits per object id: 40 (SHA-1) or 64 (SHA-256)
  packed?: ReadonlySet<string>;
}

/** git's ref_rev_parse_rules, as the prefix and suffix around a short name. */
const RULES = [
  ["", ""],
  ["refs/", ""],
  ["refs/tags/", ""],
  ["refs/heads/", ""],
  ["refs/remotes/", ""],
  ["refs/remotes/", "/HEAD"],
] as const;
const SYMREF_MAX_DEPTH = 5; // git's SYMREF_MAXDEPTH, counting HEAD itself
const MAX_FILE_BYTES = 1 << 20;
const MAX_PACKED_REFS_BYTES = 16 << 20;
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0); // opening a FIFO must not block
const UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const V0_EXTENSIONS = /^(?:noop|preciousobjects|partialclone|worktreeconfig)=/;
const V1_EXTENSIONS = /^(?:noop-v1|relativeworktrees)=|^refstorage=files$|^objectformat=sha(?:1|256)$/;
/** Thrown for anything this reader does not model; reported as `unsupported`. */
const NOT_MODELED = new Error("git repository layout not modeled");

export function readGitHeadBranch(cwd: string): GitHeadBranchRead {
  try {
    const start = realpath(cwd);
    const repo = statSync(start).isDirectory() ? discover(start) : undefined;
    if (repo === undefined) return { kind: "none" };
    // rev-parse looks "HEAD" up through every rule and prints nothing when several resolve.
    const heads = RULES.map(([prefix, suffix]) => resolveRef(repo, `${prefix}HEAD${suffix}`))
      .filter((ref) => ref !== undefined);
    if (heads.length === 1) return { kind: "branch", name: shorten(repo, heads[0]) };
    if (heads.length > 1) return { kind: "none" };
    // Not a revision (unborn branch): rev-parse then succeeds only if a file makes HEAD a path.
    return fileStats(join(start, "HEAD"), false) ? { kind: "branch", name: "HEAD" } : { kind: "none" };
  } catch (error) {
    return error === NOT_MODELED ? { kind: "unsupported" } : { kind: "none" };
  }
}

/** setup_git_directory's walk: `<dir>/.git` (file or directory), then `<dir>` itself, up to a filesystem boundary. */
function discover(start: string): Repository | undefined {
  const device = statSync(start).dev;
  let dir = start;
  for (;;) {
    const dotGit = join(dir, ".git");
    if (fileStats(dotGit)?.isFile() === true) return fromGitFile(dir, dotGit);
    if (isGitDirectory(dotGit)) return owned([dir, dotGit]) ? openRepository(dotGit) : undefined;
    if (isGitDirectory(dir)) return owned([dir]) ? openRepository(dir) : undefined;
    const parent = dirname(dir);
    if (parent === dir || statSync(parent).dev !== device) return undefined;
    dir = parent;
  }
}

/** read_gitfile_gently: "gitdir: <path>", relative to the file's directory. git dies on any defect. */
function fromGitFile(dir: string, dotGit: string): Repository | undefined {
  const text = readText(dotGit) ?? "";
  const path = text.replace(/[\r\n]+$/, "").slice("gitdir: ".length);
  if (!text.startsWith("gitdir: ") || path.length === 0) return undefined;
  const gitDir = realpath(isAbsolute(path) ? path : `${dir}/${path}`);
  if (!isGitDirectory(gitDir)) return undefined;
  return owned([dotGit, dir, gitDir]) ? openRepository(gitDir) : undefined;
}

/** is_git_directory: a valid HEAD, plus searchable objects/ and refs/ in the common dir. */
function isGitDirectory(dir: string): boolean {
  if (!validHead(join(dir, "HEAD"))) return false;
  const commonDir = commonDirOf(dir);
  try {
    accessSync(join(commonDir, "objects"), constants.X_OK);
    accessSync(join(commonDir, "refs"), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** validate_headref: a "refs/..." symlink, or a file starting with "ref: refs/" or an object id. */
function validHead(path: string): boolean {
  try {
    if (lstatSync(path).isSymbolicLink()) return readlinkSync(path, "latin1").startsWith("refs/");
    const head = readFile(path)?.toString("latin1", 0, 255) ?? "";
    return /^(?:ref:[\t\n\r ]*refs\/|[0-9a-fA-F]{40})/.test(head);
  } catch {
    return false;
  }
}

/** get_common_dir: a linked worktree's `commondir` file names the shared repository. */
function commonDirOf(gitDir: string): string {
  const text = readText(join(gitDir, "commondir"));
  if (text === undefined) return gitDir;
  if (text.length === 0) throw new Error(`empty commondir in ${gitDir}`); // git dies
  const path = text.replace(/[\r\n]+$/, "");
  return realpath(isAbsolute(path) ? path : `${gitDir}/${path}`);
}

/** ensure_valid_ownership with no safe.directory: git refuses paths another user owns (POSIX only). */
function owned(paths: readonly string[]): boolean {
  const euid = process.geteuid?.();
  if (euid === undefined) return true;
  // As in git, root also accepts files of the user who ran sudo.
  const sudoUid = process.env.SUDO_UID ?? "";
  const accepted = euid === 0 && /^\d+$/.test(sudoUid) ? [0, Number(sudoUid)] : [euid];
  return paths.every((path) => accepted.includes(lstatSync(path).uid));
}

/** The repository at a discovered gitdir, after git's repository format check. */
function openRepository(gitDir: string): Repository {
  const commonDir = commonDirOf(gitDir);
  const oidLength = repositoryFormat(commonDir, gitDir);
  // Reftable keeps this placeholder HEAD so older gits refuse the repository.
  const head = readText(join(gitDir, "HEAD")) ?? "";
  if (/^ref:\s*refs\/heads\/\.invalid\s*$/.test(head) && fileStats(join(commonDir, "reftable"), false)) {
    throw NOT_MODELED;
  }
  return { gitDir, commonDir, oidLength };
}

/**
 * Object id length from the common config. Not modeled: reftable and unknown extensions, a format version
 * other than 0 or 1, and core.warnAmbiguousRefs (it changes the shortening) or includes that could set it.
 */
function repositoryFormat(commonDir: string, gitDir: string): number {
  const config = configEntries(readText(join(commonDir, "config")) ?? "");
  const worktree = config.some(([key]) => key === "extensions.worktreeconfig")
    ? configEntries(readText(join(gitDir, "config.worktree")) ?? "")
    : [];
  if ([...config, ...worktree].some(([key]) => /^include(?:if)?\.|^core\.warnambiguousrefs$/.test(key))) {
    throw NOT_MODELED;
  }
  const version = config.findLast(([key]) => key === "core.repositoryformatversion")?.[1];
  if (version === undefined) return 40; // without a format version git ignores every extension
  if (version !== "0" && version !== "1") throw NOT_MODELED;
  let oidLength = 40;
  for (const [key, value = ""] of config) {
    if (!key.startsWith("extensions.")) continue;
    const entry = `${key.slice("extensions.".length)}=${value}`;
    if (!V0_EXTENSIONS.test(entry) && !(version === "1" && V1_EXTENSIONS.test(entry))) throw NOT_MODELED;
    if (entry.startsWith("objectformat=")) oidLength = entry === "objectformat=sha256" ? 64 : 40;
  }
  return oidLength;
}

/** `section[.subsection].key` and value of each variable in a git config file (includes are not followed). */
function configEntries(text: string): Array<readonly [string, string | undefined]> {
  const entries: Array<readonly [string, string | undefined]> = [];
  let section = "";
  for (const raw of text.split("\n")) {
    let line = raw.trim();
    const header = /^\[\s*([A-Za-z0-9.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line);
    if (header !== null) {
      section = header[1].toLowerCase() + (header[2] === undefined ? "" : `.${header[2]}`);
      line = line.slice(header[0].length).trim();
    }
    const variable = /^([A-Za-z][A-Za-z0-9-]*)\s*(?:=\s*([^#;]*))?/.exec(line);
    if (variable !== null) {
      entries.push([`${section}.${variable[1].toLowerCase()}`, variable[2]?.trim().replace(/^"(.*)"$/, "$1")]);
    }
  }
  return entries;
}

/** refs_resolve_ref_unsafe in reading mode: the ref a name finally resolves to, if it exists. */
function resolveRef(repo: Repository, name: string): string | undefined {
  let current = name;
  for (let depth = 0; depth < SYMREF_MAX_DEPTH; depth += 1) {
    if (!validRefName(current)) return undefined;
    const raw = readRawRef(repo, current);
    if (raw?.target === undefined) return raw === undefined ? undefined : current;
    current = raw.target;
  }
  return undefined;
}

/** files_read_raw_ref: a loose file (or "refs/..." symlink), else packed-refs. `target` marks a symbolic ref. */
function readRawRef(repo: Repository, name: string): { readonly target?: string } | undefined {
  const path = refPath(repo, name);
  let stats: Stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    return isMissing(error) && packedRefs(repo).has(name) ? {} : undefined;
  }
  if (stats.isSymbolicLink()) {
    const target = utf8(readlinkSync(path, { encoding: "buffer" }));
    if (target.startsWith("refs/") && validRefName(target)) return { target };
  } else if (stats.isDirectory()) {
    return packedRefs(repo).has(name) ? {} : undefined;
  }
  // git trims trailing whitespace, then reads the content as a C string.
  const text = readText(path)?.replace(/[\t\n\r ]+$/, "").split("\0")[0];
  if (text === undefined) return undefined;
  if (text.startsWith("ref:")) return { target: text.slice("ref:".length).replace(/^[\t\n\r ]+/, "") };
  return new RegExp(`^[0-9a-fA-F]{${repo.oidLength}}(?:[\\t\\n\\r ]|$)`).test(text) ? {} : undefined;
}

/** files_ref_path: HEAD-like and per-worktree refs live in the gitdir, everything else in the common dir. */
function refPath(repo: Repository, name: string): string {
  const perWorktree = (ref: string) => /^[A-Z_-]+$/.test(ref) || /^refs\/(?:worktree|bisect|rewritten)\//.test(ref);
  const mainRef = name.slice("main-worktree/".length);
  if (name.startsWith("main-worktree/") && perWorktree(mainRef)) return join(repo.commonDir, mainRef);
  return join(perWorktree(name) ? repo.gitDir : repo.commonDir, name);
}

/** Ref names in packed-refs: "<oid> <refname>" records; the "#" header and "^" peeled lines never match. */
function packedRefs(repo: Repository): ReadonlySet<string> {
  if (repo.packed === undefined) {
    const record = new RegExp(`^[0-9a-fA-F]{${repo.oidLength}} (.*)$`, "s");
    const names = new Set<string>();
    for (const line of (readText(join(repo.commonDir, "packed-refs"), MAX_PACKED_REFS_BYTES) ?? "").split("\n")) {
      const match = record.exec(line);
      if (match !== null) names.add(match[1]);
    }
    repo.packed = names;
  }
  return repo.packed;
}

/** refs_shorten_unambiguous_ref, strict: from the last rule down, the first short name no other rule resolves. */
function shorten(repo: Repository, full: string): string {
  for (let i = RULES.length - 1; i > 0; i -= 1) {
    const [prefix, suffix] = RULES[i];
    if (!full.startsWith(prefix) || !full.endsWith(suffix) || full.length < prefix.length + suffix.length) continue;
    const short = full.slice(prefix.length, full.length - suffix.length);
    if (RULES.every(([p, s], j) => j === i || resolveRef(repo, `${p}${short}${s}`) === undefined)) return short;
  }
  return full;
}

/** check_refname_format with REFNAME_ALLOW_ONELEVEL, the git-check-ref-format(1) rules. */
function validRefName(name: string): boolean {
  return name !== "@" && !name.endsWith(".") && !/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{/.test(name)
    && name.split("/").every((part) => part !== "" && !part.startsWith(".") && !part.endsWith(".lock"));
}

function fileStats(path: string, follow = true): Stats | undefined {
  try {
    return follow ? statSync(path) : lstatSync(path);
  } catch {
    return undefined;
  }
}

/** A regular file of at most `limit` bytes, or undefined when it does not exist. FIFOs are refused unread. */
function readFile(path: string, limit = MAX_FILE_BYTES): Buffer | undefined {
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error(`not a regular file: ${path}`);
    if (stats.size > limit) throw NOT_MODELED;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readText(path: string, limit?: number): string | undefined {
  const bytes = readFile(path, limit);
  return bytes === undefined ? undefined : utf8(bytes);
}

function realpath(path: string): string {
  return utf8(realpathSync.native(path, { encoding: "buffer" }));
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/** Text that maps back to the same bytes; anything else is not modeled. */
function utf8(bytes: Uint8Array): string {
  try {
    return UTF8.decode(bytes);
  } catch {
    throw NOT_MODELED;
  }
}
