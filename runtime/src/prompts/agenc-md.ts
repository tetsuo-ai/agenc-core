/**
 * Tiered AGENC.md instruction loader with `@include` directive support.
 *
 * Owns the 4-tier precedence (Managed → User → Project → Local), the
 * `@include` expansion with circular-reference detection, and the I-75
 * path-boundary check for AgenC instruction files.
 *
 * Tier sources:
 *   1. **Managed** — system override. `$AGENC_MANAGED_INSTRUCTIONS` if set,
 *      else `/etc/agenc/AGENC.md`.
 *   2. **User** — per-user global. `~/.agenc/AGENC.md`.
 *   3. **Project** — the ancestor-walk result from
 *      {@link loadProjectInstructions}.
 *   4. **Local** — per-checkout gitignored. `<projectRoot>/AGENC.local.md`.
 *
 * `@include` directive (I-75):
 *   - Syntax: `@include <relative-path>` on its own line.
 *   - Resolved relative to the including file's directory.
 *   - Target must stay inside the tier's base directory. Paths escaping
 *     via `..` or absolute escapes are rejected with a warning.
 *   - Circular chains are detected and the re-entry is skipped.
 *   - Max nesting depth: 10. Max total expansion: 5 MiB.
 *   - Expanded inline with a `<!-- @include <path> -->` comment marker.
 *
 * @module
 */
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { normalizeExternalText } from "./_deps/file-read.js";
import {
  type ExternalInstructionApprovalStore,
  type InstructionFileIdentity,
  instructionFileIdentityKey,
  readInstructionFileSnapshot,
} from "./secure-instruction-file.js";
import {
  DEFAULT_PROJECT_DOC_MAX_BYTES,
  DEFAULT_PROJECT_ROOT_MARKERS,
  AGENTS_PROJECT_INSTRUCTION_FILE,
  PRIMARY_PROJECT_INSTRUCTION_FILE,
  findProjectRoot,
  loadProjectInstructionChain,
  projectInstructionDirectories,
  type ProjectInstructionChainEntry,
  type ProjectInstructionsConfig,
} from "./project-instructions.js";
import {
  DEFAULT_MANAGED_RULES_DIR,
  discoverInstructionRulesDetailed,
  formatRulesBlock,
  projectRulesDir,
  type RuleDiscoveryLedger,
} from "./rules/discovery.js";

/** Default max nesting depth for `@include` expansion. */
const DEFAULT_INCLUDE_MAX_DEPTH = 10;
/** Default total expansion budget (5 MiB) to guard against fork bombs. */
const DEFAULT_INCLUDE_MAX_BYTES = 5 * 1024 * 1024;
const MAX_INCLUDE_DEPTH_LIMIT = 64;
const MAX_INCLUDE_REFERENCES = 512;

function boundedIntegerOption(
  name: string,
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 0 || resolved > maximum) {
    throw new RangeError(`${name} must be a finite integer between 0 and ${maximum}`);
  }
  return resolved;
}

/** Filename convention for per-user global instructions. */
const USER_INSTRUCTION_FILENAME = "AGENC.md";
/** Filename convention for per-checkout local instructions. */
const LOCAL_INSTRUCTION_FILENAME = "AGENC.local.md";
/** Default system-wide managed instructions path. */
const DEFAULT_MANAGED_INSTRUCTION_PATH = "/etc/agenc/AGENC.md";

export type InstructionTier = "managed" | "user" | "project" | "local";

/**
 * A loaded tier entry. `content` is post-@include-expansion; `rawContent`
 * is the original file before expansion (useful for caching/diagnostics).
 */
export interface TierEntry {
  readonly tier: InstructionTier;
  readonly path: string;
  /** Canonical machine/user/workspace boundary where this tier applies. */
  readonly scopePath: string;
  readonly content: string;
  readonly rawContent: string;
  readonly dropped: DroppedInclude[];
  readonly dependencies: readonly string[];
}

export interface TieredInstructions {
  readonly managed: TierEntry | null;
  readonly user: TierEntry | null;
  readonly project: TierEntry | null;
  readonly local: TierEntry | null;
}

export interface LoadTieredInstructionsOptions extends ProjectInstructionsConfig {
  /** Current working directory for project/local tier discovery. */
  readonly cwd: string;
  /** Override `HOME` for testing. Defaults to `os.homedir()`. */
  readonly homeDir?: string;
  /** Resolved AgenC config home (AGENC_CONFIG_DIR/AGENC_HOME), if relocated. */
  readonly configHomeDir?: string;
  /** Explicit source policy. Omitted means all four tiers. */
  readonly enabledTiers?: readonly InstructionTier[];
  /**
   * Override the managed instructions path for testing. Defaults to
   * `$AGENC_MANAGED_INSTRUCTIONS` env var or
   * {@link DEFAULT_MANAGED_INSTRUCTION_PATH}.
   */
  readonly managedPath?: string;
  /** Max `@include` nesting depth. Default 10. */
  readonly includeMaxDepth?: number;
  /** Max total `@include` expansion bytes. Default 5 MiB. */
  readonly includeMaxBytes?: number;
  /** Trusted operator channel for exact external includes. Disabled by default. */
  readonly externalApprovals?: ExternalInstructionApprovalStore;
}

/** Metadata about a rejected/skipped `@include` target. */
export interface DroppedInclude {
  readonly requestedPath: string;
  readonly reason:
    | "path_escape"
    | "circular"
    | "max_depth"
    | "max_bytes"
    | "not_found"
    | "read_error"
    | "not_regular_file"
    | "symlink"
    | "hard_link"
    | "unstable"
    | "approval_required"
    | "approval_expired"
    | "invalid_path";
  readonly includingFile: string;
  /** Local operator evidence; never rendered into the model-visible marker. */
  readonly canonicalPath?: string;
  readonly identity?: InstructionFileIdentity;
}

export interface ResolveIncludesOptions {
  /** Directory the content originated from (for relative resolution). */
  readonly baseDir: string;
  /**
   * Outermost boundary for I-75 path checks. All resolved `@include`
   * targets must stay inside this directory.
   */
  readonly projectRoot: string;
  /** Max nesting depth (default 10). */
  readonly maxDepth?: number;
  /** Max total expansion size in bytes (default 5 MiB). */
  readonly maxBytes?: number;
  /** Path of the file containing `content`; required for exact external approval. */
  readonly includingFile?: string;
  readonly includingFileSha256?: string;
  /** Pinned workspace identity used to scope operator approvals. */
  readonly workspaceRoot?: string;
  readonly externalApprovals?: ExternalInstructionApprovalStore;
  /** Shared byte ledger when several files contribute to one tier/envelope. */
  readonly ledger?: InstructionExpansionLedger;
}

export interface ResolvedContent {
  readonly text: string;
  readonly included: string[];
  readonly dropped: DroppedInclude[];
  readonly probes: readonly InstructionCacheProbe[];
}

interface InstructionCacheProbe {
  readonly path: string;
  readonly identity: InstructionFileIdentity | null;
}

interface InstructionExpansionLedger {
  totalBytes: number;
  references: number;
}

interface InstructionCacheEvidence {
  readonly probes: Map<string, string | null>;
  cacheable: boolean;
}

function recordCacheProbe(
  evidence: InstructionCacheEvidence,
  probe: InstructionCacheProbe,
): void {
  const key = probe.identity === null
    ? null
    : instructionFileIdentityKey(probe.identity);
  const existing = evidence.probes.get(probe.path);
  if (existing !== undefined && existing !== key) evidence.cacheable = false;
  evidence.probes.set(probe.path, key);
}

/** Regex for `@include <path>` directives at line start. */
const INCLUDE_LINE_RE = /^[ \t]*@include[ \t]+(.+?)[ \t]*$/gm;

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * I-75 boundary check (lexical). Returns true when `candidate` is inside
 * `boundary` (or equal to it). Uses resolved absolute paths and
 * `path.relative` to detect escapes (including via `..` or absolute
 * overrides).
 *
 * NOTE: lexical-only — does not follow symlinks. Production expansion
 * routes through {@link isPathWithinReal} which resolves symlinks via
 * `fs.realpath` to close the symlink-escape attack. Kept exported for
 * callers that want pure-lexical reasoning on paths that may not exist.
 */
export function isPathWithin(candidate: string, boundary: string): boolean {
  const absBoundary = resolve(boundary);
  const absCandidate = resolve(candidate);
  if (absCandidate === absBoundary) return true;
  const rel = relative(absBoundary, absCandidate);
  if (rel === "" ) return true;
  // Any `..` component or an absolute rel path means candidate escapes.
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * I-75 boundary check (realpath-aware, async). Canonicalizes both
 * `candidate` and `boundary` via `fs.realpath` before comparing. This
 * closes the symlink-escape attack where an in-tree symlink points to
 * a file outside the project root (e.g. `<repo>/bad -> /etc/passwd`):
 * the lexical {@link isPathWithin} would pass, but the realpath version
 * rejects.
 *
 * Fails closed (returns `false`) when either side's `realpath` fails —
 * e.g. the candidate does not exist yet, or a broken symlink. Missing
 * targets are surfaced separately through the `not_found` drop reason
 * after this check, so a false here is safe.
 */
/**
 * Expand `@include <path>` directives in `content` recursively.
 *
 * - Relative paths resolved against the including file's directory.
 * - Targets must stay within `projectRoot` (I-75). Escapes rejected.
 * - Circular chains detected via the active include-stack.
 * - Hard caps: `maxDepth` nested levels, `maxBytes` total expansion.
 * - Missing/unreadable targets dropped with a warning record.
 */
export async function resolveIncludes(
  content: string,
  opts: ResolveIncludesOptions,
): Promise<ResolvedContent> {
  const maxDepth = boundedIntegerOption(
    "include max depth",
    opts.maxDepth,
    DEFAULT_INCLUDE_MAX_DEPTH,
    MAX_INCLUDE_DEPTH_LIMIT,
  );
  const maxBytes = boundedIntegerOption(
    "include max bytes",
    opts.maxBytes,
    DEFAULT_INCLUDE_MAX_BYTES,
    DEFAULT_INCLUDE_MAX_BYTES,
  );
  const included: string[] = [];
  const dropped: DroppedInclude[] = [];
  const probes: InstructionCacheProbe[] = [];
  // Byte ledger shared across recursion and, for project chains, across every
  // ancestor file. This prevents N files from each independently consuming the
  // advertised expansion cap.
  const state = opts.ledger ?? { totalBytes: 0, references: 0 };
  const contentBytes = Buffer.byteLength(content, "utf8");
  const remainingForContent = Math.max(0, maxBytes - state.totalBytes);
  if (contentBytes > remainingForContent) {
    state.totalBytes = maxBytes;
    return {
      text: truncateUtf8Bytes(content, remainingForContent),
      included,
      dropped,
      probes,
    };
  }
  state.totalBytes += contentBytes;

  const text = await expandText({
    text: content,
    baseDir: opts.baseDir,
    projectRoot: resolve(opts.projectRoot),
    workspaceRoot: resolve(opts.workspaceRoot ?? opts.projectRoot),
    includingFile: opts.includingFile ?? opts.baseDir,
    ...(opts.includingFileSha256 !== undefined
      ? { includingFileSha256: opts.includingFileSha256 }
      : {}),
    externalApprovals: opts.externalApprovals,
    stack: [],
    depth: 0,
    maxDepth,
    maxBytes,
    included,
    dropped,
    probes,
    state,
  });

  return { text, included, dropped, probes };
}

function truncateUtf8Bytes(content: string, maximumBytes: number): string {
  if (maximumBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  for (const char of content) {
    const width = Buffer.byteLength(char, "utf8");
    if (bytes + width > maximumBytes) break;
    bytes += width;
    end += char.length;
  }
  return content.slice(0, end);
}

interface ExpandCtx {
  text: string;
  baseDir: string;
  projectRoot: string;
  workspaceRoot: string;
  /** Absolute path of the currently-including file (or baseDir root). */
  includingFile: string;
  includingFileSha256?: string;
  /** Absolute paths of ancestors in the include chain (for cycle check). */
  stack: readonly string[];
  depth: number;
  maxDepth: number;
  maxBytes: number;
  included: string[];
  dropped: DroppedInclude[];
  probes: InstructionCacheProbe[];
  state: InstructionExpansionLedger;
  externalApprovals?: ExternalInstructionApprovalStore;
}

async function expandText(ctx: ExpandCtx): Promise<string> {
  const matches: Array<{ start: number; end: number; raw: string; target: string }> = [];
  INCLUDE_LINE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = INCLUDE_LINE_RE.exec(ctx.text)) !== null) {
    matches.push({
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
      target: m[1]!.trim(),
    });
  }
  if (matches.length === 0) return ctx.text;

  let out = "";
  let cursor = 0;
  for (const match of matches) {
    out += ctx.text.slice(cursor, match.start);
    cursor = match.end;

    const drop = (
      reason: DroppedInclude["reason"],
      extra?: string,
      localEvidence?: Pick<DroppedInclude, "canonicalPath" | "identity">,
    ): string => {
      ctx.dropped.push({
        requestedPath: match.target,
        reason,
        includingFile: ctx.includingFile,
        ...(localEvidence?.canonicalPath !== undefined
          ? { canonicalPath: localEvidence.canonicalPath }
          : {}),
        ...(localEvidence?.identity !== undefined
          ? { identity: localEvidence.identity }
          : {}),
      });
      // Every reason carries a human-readable rejection marker with the
      // reason (and optional extra context such as cycle entry, depth
      // limit, or byte cap) so the downstream prompt makes the drop
      // visible instead of failing silently.
      return extra !== undefined
        ? `<!-- @include ${match.target} (rejected: ${reason}; ${extra}) -->`
        : `<!-- @include ${match.target} (rejected: ${reason}) -->`;
    };

    if (ctx.state.references >= MAX_INCLUDE_REFERENCES) {
      out += "<!-- further @include references rejected: reference_limit -->";
      cursor = ctx.text.length;
      break;
    }
    ctx.state.references += 1;

    // Null-byte / control-char guard. POSIX `open(2)` treats `\0` as the
    // path terminator and would silently truncate; reject up front so an
    // attacker can't smuggle `foo\0.md` past later checks.
    if (match.target.includes("\0")) {
      out += drop("invalid_path");
      continue;
    }

    const resolved = resolve(ctx.baseDir, match.target);
    const lexicallyExternal = !isPathWithin(resolved, ctx.projectRoot);

    // Depth guard.
    if (ctx.depth + 1 > ctx.maxDepth) {
      out += drop("max_depth", `depth=${ctx.depth + 1} > max=${ctx.maxDepth}`);
      continue;
    }

    const remainingBytes = Math.max(0, ctx.maxBytes - ctx.state.totalBytes);
    const read = await readInstructionFileSnapshot({
      requestedPath: resolved,
      boundaryRoot: ctx.projectRoot,
      workspaceRoot: ctx.workspaceRoot,
      sourceClass: "include",
      maximumBytes: remainingBytes,
      includedBy: ctx.includingFile,
      ...(ctx.includingFileSha256 !== undefined
        ? { includedBySha256: ctx.includingFileSha256 }
        : {}),
      externalApprovals: ctx.externalApprovals,
    });
    if (!read.ok) {
      ctx.probes.push({
        path: read.canonicalPath ?? resolved,
        identity: read.identity ?? null,
      });
      const mapped: DroppedInclude["reason"] = lexicallyExternal
        ? read.reason === "approval_expired"
          ? "approval_expired"
          : "approval_required"
        : read.reason === "not_found" || read.reason === "boundary_unavailable"
          ? "not_found"
          : read.reason === "outside_boundary"
            ? "path_escape"
            : read.reason === "too_large"
              ? "max_bytes"
              : read.reason === "not_regular_file"
                ? "not_regular_file"
                : read.reason === "symlink"
                  ? "symlink"
                  : read.reason === "hard_link"
                    ? "hard_link"
                    : read.reason === "unstable"
                      ? "unstable"
                      : read.reason === "approval_required"
                        ? "approval_required"
                        : read.reason === "approval_expired"
                          ? "approval_expired"
                          : "read_error";
      const extra =
        mapped === "max_bytes"
          ? `cap=${ctx.maxBytes}B; used=${ctx.state.totalBytes}B`
          : undefined;
      out += drop(mapped, extra, {
        ...(read.canonicalPath !== undefined
          ? { canonicalPath: read.canonicalPath }
          : {}),
        ...(read.identity !== undefined ? { identity: read.identity } : {}),
      });
      continue;
    }
    const canonicalPath = read.snapshot.canonicalPath;
    ctx.probes.push({
      path: canonicalPath,
      identity: read.snapshot.identity,
    });

    // Cycle detection is identity-path based after the secure open.
    if (ctx.stack.includes(canonicalPath)) {
      out += drop(
        "circular",
        `cycle via ${ctx.stack.length > 0 ? ctx.stack.join(" -> ") : "self"}`,
      );
      continue;
    }

    const raw = read.snapshot.text;

    // Byte-budget guard before recursion.
    const addBytes = Buffer.byteLength(raw, "utf8");
    if (ctx.state.totalBytes + addBytes > ctx.maxBytes) {
      out += drop(
        "max_bytes",
        `would add ${addBytes}B; cap=${ctx.maxBytes}B; used=${ctx.state.totalBytes}B`,
      );
      continue;
    }
    ctx.state.totalBytes += addBytes;

    ctx.included.push(canonicalPath);
    const okMarker = `<!-- @include ${match.target} -->`;
    const nested = await expandText({
      text: raw,
      baseDir: pathDir(canonicalPath),
      projectRoot: ctx.projectRoot,
      workspaceRoot: ctx.workspaceRoot,
      includingFile: canonicalPath,
      includingFileSha256: read.snapshot.sha256,
      stack: [...ctx.stack, canonicalPath],
      depth: ctx.depth + 1,
      maxDepth: ctx.maxDepth,
      maxBytes: ctx.maxBytes,
      included: ctx.included,
      dropped: ctx.dropped,
      probes: ctx.probes,
      state: ctx.state,
      externalApprovals: ctx.externalApprovals,
    });
    out += `${okMarker}\n${nested}`;
  }
  out += ctx.text.slice(cursor);
  return out;
}

/**
 * Keep the path-dir helper local; avoids importing the whole path module
 * repeatedly and clarifies intent in `expandText`.
 */
function pathDir(p: string): string {
  return dirname(p);
}

/**
 * Read a single file, run `@include` expansion on its contents, and
 * wrap the result in a {@link TierEntry}. Returns null when the path
 * is missing or empty.
 */
async function loadTier(
  tier: InstructionTier,
  filePath: string,
  boundary: string,
  includeMaxDepth: number,
  includeMaxBytes: number,
  workspaceRoot: string,
  expansionLedger: InstructionExpansionLedger,
  cacheEvidence: InstructionCacheEvidence,
  externalApprovals?: ExternalInstructionApprovalStore,
): Promise<TierEntry | null> {
  const remainingBytes = Math.max(
    0,
    includeMaxBytes - expansionLedger.totalBytes,
  );
  if (remainingBytes === 0) return null;
  const read = await readInstructionFileSnapshot({
    requestedPath: filePath,
    boundaryRoot: boundary,
    workspaceRoot,
    sourceClass: tier,
    maximumBytes: remainingBytes,
  });
  if (!read.ok || read.snapshot.text.trim().length === 0) return null;
  recordCacheProbe(cacheEvidence, {
    path: read.snapshot.canonicalPath,
    identity: read.snapshot.identity,
  });
  const raw = read.snapshot.text;

  const resolved = await resolveIncludes(raw, {
    baseDir: pathDir(filePath),
    projectRoot: boundary,
    maxDepth: includeMaxDepth,
    maxBytes: includeMaxBytes,
    includingFile: read.snapshot.canonicalPath,
    includingFileSha256: read.snapshot.sha256,
    workspaceRoot,
    externalApprovals,
    ledger: expansionLedger,
  });
  for (const probe of resolved.probes) recordCacheProbe(cacheEvidence, probe);

  return {
    tier,
    path: filePath,
    scopePath: resolve(boundary),
    content: resolved.text,
    rawContent: raw,
    dropped: resolved.dropped,
    dependencies: [read.snapshot.canonicalPath, ...resolved.included],
  };
}

function formatProjectTierChainEntry(
  entry: Pick<ProjectInstructionChainEntry, "path">,
  content: string,
): string {
  return `--- project-doc (${entry.path}) ---\n\n${normalizeExternalText(content).trim()}`;
}

async function appendUnconditionalRules(
  content: string,
  rulesDir: string,
  type: "Managed" | "User" | "Project" | "Local",
  boundaryDir?: string,
  dependencyPaths?: string[],
  cacheEvidence?: InstructionCacheEvidence,
  resourceLedger?: RuleDiscoveryLedger,
): Promise<string> {
  const discovery = await discoverInstructionRulesDetailed({
    rulesDir,
    type,
    ...(boundaryDir !== undefined ? { boundaryDir } : {}),
    includeUnconditional: true,
    includeConditional: false,
    ...(resourceLedger !== undefined ? { resourceLedger } : {}),
  });
  if (discovery.overflowed && cacheEvidence !== undefined) {
    cacheEvidence.cacheable = false;
  }
  if (cacheEvidence !== undefined) {
    for (const directory of discovery.directories) {
      recordCacheProbe(cacheEvidence, directory);
    }
    for (const file of discovery.files) {
      recordCacheProbe(cacheEvidence, { path: file.path, identity: file.identity });
    }
  }
  const rules = discovery.rules;
  // Durable instruction provenance lists content-bearing sources only.
  // Directory and negative probes remain in cache evidence, but they did not
  // contribute instructions and must not be reported as model input.
  dependencyPaths?.push(...rules.map((rule) => rule.path));
  const block = formatRulesBlock(rules);
  if (block.length === 0) return content;
  return content.length === 0 ? block : `${content}\n\n${block}`;
}

/**
 * identity-keyed cache for {@link loadTieredInstructions}.
 *
 * Audit finding: prepareTurnRuntimeInputs reloads AGENC.md every turn,
 * even when the file is unchanged. Across 80 turns of a session that's
 * 80× the disk I/O + 80× the @include resolution + 80× the rules-dir
 * scan for content that did not change.
 *
 * Strategy: cache the resolved {@link TieredInstructions} keyed by
 * (cwd, managedPath, config home, policy). Descriptor-bound identities for
 * every opened file, stable identities for every traversed rule directory,
 * and exact negative candidate probes are recorded. Any mismatch — including
 * a file appearing/disappearing — invalidates and reloads.
 *
 * Cache publication verifies that every path still names its captured object;
 * a concurrent mutation makes that resolution non-cacheable.
 *
 * Exposed as a separate module-scope state so tests can clear it via
 * {@link clearTieredInstructionsCacheForTesting}.
 */
type CachedTieredInstructions = {
  readonly cachedPaths: ReadonlyArray<{
    readonly path: string;
    readonly identity: string | null;
  }>;
  readonly result: TieredInstructions;
};

const tieredInstructionsCache = new Map<string, CachedTieredInstructions>();

function tieredInstructionsCacheKey(opts: LoadTieredInstructionsOptions): string {
  // managedPath + homeDir resolution mirrors the body of
  // loadTieredInstructions so a key generated here always matches the
  // key the live call site would compute.
  const managedPath =
    opts.managedPath ??
    process.env.AGENC_MANAGED_INSTRUCTIONS ??
    DEFAULT_MANAGED_INSTRUCTION_PATH;
  const home = opts.homeDir ?? homedir();
  const configHome = opts.configHomeDir ?? join(home, ".agenc");
  // includeMaxDepth/Bytes also affect output, but most callers use the
  // defaults; key them too so a caller bumping the budget never gets a
  // stale shorter-budget result.
  const includeMaxDepth = boundedIntegerOption(
    "include max depth",
    opts.includeMaxDepth,
    DEFAULT_INCLUDE_MAX_DEPTH,
    MAX_INCLUDE_DEPTH_LIMIT,
  );
  const includeMaxBytes = boundedIntegerOption(
    "include max bytes",
    opts.includeMaxBytes,
    DEFAULT_INCLUDE_MAX_BYTES,
    DEFAULT_INCLUDE_MAX_BYTES,
  );
  return [
    opts.cwd,
    managedPath,
    home,
    configHome,
    JSON.stringify(opts.enabledTiers ?? ["managed", "user", "project", "local"]),
    includeMaxDepth,
    includeMaxBytes,
    opts.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
    JSON.stringify(opts.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS),
  ].join("|");
}

async function statIdentity(path: string): Promise<string | null> {
  try {
    const value = await lstat(path, { bigint: true });
    return [
      value.dev,
      value.ino,
      value.mode,
      value.nlink,
      value.size,
      value.mtimeNs,
      value.ctimeNs,
    ].join(":");
  } catch {
    return null;
  }
}

async function cachedTierPathsMatchDisk(
  cached: CachedTieredInstructions,
): Promise<boolean> {
  for (const entry of cached.cachedPaths) {
    const live = await statIdentity(entry.path);
    if (live !== entry.identity) return false;
  }
  return true;
}

/** Test-only: drop all cached entries. Used by mtime-cache tests. */
export function clearTieredInstructionsCacheForTesting(): void {
  tieredInstructionsCache.clear();
}

/**
 * Load all four tiers for a given working directory.
 *
 * Missing tiers come back as `null` — callers filter/concat via
 * {@link assembleTieredInstructions}.
 *
 * Result is cached and re-validated by mtime: subsequent calls with
 * the same cwd / homeDir / managedPath return the cached
 * {@link TieredInstructions} without re-reading any file as long as
 * none of the previously-loaded tier files have changed on disk.
 * See {@link tieredInstructionsCache} for the invalidation contract.
 */
export async function loadTieredInstructions(
  opts: LoadTieredInstructionsOptions,
): Promise<TieredInstructions> {
  // Exact approvals are revocable and expire independently of filesystem
  // mtimes, so an approval-bearing resolution is never served from cache.
  if (opts.externalApprovals !== undefined) {
    return loadTieredInstructionsUncached(opts, {
      probes: new Map(),
      cacheable: false,
    });
  }
  const cacheKey = tieredInstructionsCacheKey(opts);
  const cached = tieredInstructionsCache.get(cacheKey);
  if (cached !== undefined && (await cachedTierPathsMatchDisk(cached))) {
    return cached.result;
  }
  // Capture negative-candidate state before resolution. If a higher-priority
  // file appears while the loader is running, the before/after mismatch makes
  // this fill non-cacheable instead of pinning lower-priority content under the
  // new file's identity.
  const candidates = [...new Set(canonicalTierPaths(opts))];
  const beforeCandidates = new Map<string, string | null>();
  for (const candidate of candidates) {
    beforeCandidates.set(candidate, await statIdentity(candidate));
  }

  const evidence: InstructionCacheEvidence = {
    probes: new Map(),
    cacheable: true,
  };
  const result = await loadTieredInstructionsUncached(opts, evidence);

  // Descriptor-bound file identities and stable directory-scan identities are
  // authoritative. A post-load stat only verifies that the path still names
  // that same object; it never replaces the captured identity.
  for (const [path, expected] of evidence.probes) {
    if ((await statIdentity(path)) !== expected) evidence.cacheable = false;
  }
  for (const candidate of candidates) {
    if (evidence.probes.has(candidate)) continue;
    const before = beforeCandidates.get(candidate) ?? null;
    const after = await statIdentity(candidate);
    if (after !== before) evidence.cacheable = false;
    evidence.probes.set(candidate, before);
  }

  if (evidence.cacheable) {
    tieredInstructionsCache.set(cacheKey, {
      cachedPaths: [...evidence.probes].map(([path, identity]) => ({
        path,
        identity,
      })),
      result,
    });
  }
  return result;
}

/**
 * The set of paths that loadTieredInstructions COULD have read for a
 * given options bundle, regardless of whether each tier actually
 * existed. Used to seed the negative cache so a newly-appearing
 * AGENC.md (user creates one mid-session) invalidates correctly.
 *
 * Note: the project-tier file lives at the project ROOT (resolved by
 * an ancestor walk from cwd), not necessarily at cwd itself. We
 * include `cwd/AGENC.md` here as the most common case AND every
 * ancestor up to the home dir; that's a small bounded probe set
 * (typically &lt;10 directories on a real path) and catches the case
 * where the operator creates a project-tier AGENC.md anywhere up the
 * chain.
 */
function canonicalTierPaths(opts: LoadTieredInstructionsOptions): string[] {
  const enabled = new Set<InstructionTier>(
    opts.enabledTiers ?? ["managed", "user", "project", "local"],
  );
  if (enabled.size === 0) return [];

  const home = opts.homeDir ?? homedir();
  const managedPath =
    opts.managedPath ??
    process.env.AGENC_MANAGED_INSTRUCTIONS ??
    DEFAULT_MANAGED_INSTRUCTION_PATH;
  const agencHome = opts.configHomeDir ?? join(home, ".agenc");
  const userPrimary = join(agencHome, USER_INSTRUCTION_FILENAME);
  const ancestorCandidates =
    enabled.has("project") || enabled.has("local")
      ? ancestorInstructionCandidates(
          opts.cwd,
          opts.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
          enabled,
        )
      : [];
  return [
    ...(enabled.has("managed") ? [managedPath, DEFAULT_MANAGED_RULES_DIR] : []),
    ...(enabled.has("user") ? [userPrimary, join(agencHome, "rules")] : []),
    ...ancestorCandidates,
  ];
}

/**
 * Probe the finite lexical ancestor chain from cwd to the filesystem root for
 * instruction candidates and project-root markers.
 */
function ancestorInstructionCandidates(
  cwd: string,
  rootMarkers: readonly string[],
  enabled: ReadonlySet<InstructionTier>,
): string[] {
  const candidates: string[] = [];
  let current = resolve(cwd);
  while (true) {
    candidates.push(
      ...(enabled.has("project")
        ? [
            join(current, "AGENC.override.md"),
            join(current, PRIMARY_PROJECT_INSTRUCTION_FILE),
            join(current, AGENTS_PROJECT_INSTRUCTION_FILE),
            join(current, ".agenc", USER_INSTRUCTION_FILENAME),
            projectRulesDir(current),
          ]
        : []),
      ...(enabled.has("local")
        ? [join(current, LOCAL_INSTRUCTION_FILENAME)]
        : []),
      ...rootMarkers.map((marker) => join(current, marker)),
    );
    const parent = pathDir(current);
    if (parent === current) break; // root reached
    current = parent;
  }
  return candidates;
}

async function loadTieredInstructionsUncached(
  opts: LoadTieredInstructionsOptions,
  cacheEvidence: InstructionCacheEvidence,
): Promise<TieredInstructions> {
  const includeMaxDepth = boundedIntegerOption(
    "include max depth",
    opts.includeMaxDepth,
    DEFAULT_INCLUDE_MAX_DEPTH,
    MAX_INCLUDE_DEPTH_LIMIT,
  );
  const includeMaxBytes = boundedIntegerOption(
    "include max bytes",
    opts.includeMaxBytes,
    DEFAULT_INCLUDE_MAX_BYTES,
    DEFAULT_INCLUDE_MAX_BYTES,
  );
  const home = opts.homeDir ?? homedir();
  const enabled = new Set<InstructionTier>(
    opts.enabledTiers ?? ["managed", "user", "project", "local"],
  );
  const expansionLedger: InstructionExpansionLedger = {
    totalBytes: 0,
    references: 0,
  };
  const ruleLedger: RuleDiscoveryLedger = {
    scannedEntries: 0,
    scannedDirectories: 0,
    openedFiles: 0,
    bytesRead: 0,
    overflowed: false,
  };
  const managedPath =
    opts.managedPath ??
    process.env.AGENC_MANAGED_INSTRUCTIONS ??
    DEFAULT_MANAGED_INSTRUCTION_PATH;

  // Managed tier — boundary is the managed file's directory.
  const managedBase = enabled.has("managed") ? await loadTier(
    "managed",
    managedPath,
    pathDir(managedPath),
    includeMaxDepth,
    includeMaxBytes,
    opts.cwd,
    expansionLedger,
    cacheEvidence,
    opts.externalApprovals,
  ) : null;
  let managed = managedBase;
  const managedDependencies = [...(managedBase?.dependencies ?? [])];
  const managedRuleContent = enabled.has("managed") ? await appendUnconditionalRules(
    managedBase?.content ?? "",
    DEFAULT_MANAGED_RULES_DIR,
    "Managed",
    pathDir(DEFAULT_MANAGED_RULES_DIR),
    managedDependencies,
    cacheEvidence,
    ruleLedger,
  ) : "";
  if (managedRuleContent.length > 0) {
    managed =
      managedBase === null
        ? {
            tier: "managed",
            path: DEFAULT_MANAGED_RULES_DIR,
            scopePath: resolve(pathDir(DEFAULT_MANAGED_RULES_DIR)),
            content: managedRuleContent,
            rawContent: managedRuleContent,
            dropped: [],
            dependencies: managedDependencies,
          }
        : {
            ...managedBase,
            content: managedRuleContent,
            dependencies: managedDependencies,
          };
  }

  // User tier — boundary is `~/.agenc`.
  const agencHome = opts.configHomeDir ?? join(home, ".agenc");
  const userPrimary = join(agencHome, USER_INSTRUCTION_FILENAME);
  let user: TierEntry | null = null;
  if (enabled.has("user") && await pathExists(userPrimary)) {
    user = await loadTier(
      "user",
      userPrimary,
      agencHome,
      includeMaxDepth,
      includeMaxBytes,
      opts.cwd,
      expansionLedger,
      cacheEvidence,
      opts.externalApprovals,
    );
  }
  const userDependencies = [...(user?.dependencies ?? [])];
  const userRuleContent = enabled.has("user") ? await appendUnconditionalRules(
    user?.content ?? "",
    join(agencHome, "rules"),
    "User",
    agencHome,
    userDependencies,
    cacheEvidence,
    ruleLedger,
  ) : "";
  if (userRuleContent.length > 0) {
    user =
      user === null
        ? {
            tier: "user",
            path: join(agencHome, "rules"),
            scopePath: resolve(agencHome),
            content: userRuleContent,
            rawContent: userRuleContent,
            dropped: [],
            dependencies: userDependencies,
          }
        : { ...user, content: userRuleContent, dependencies: userDependencies };
  }

  // Project tier — ancestor-walk via project-instructions loader.
  const projectChain =
    enabled.has("project") && expansionLedger.totalBytes < includeMaxBytes
      ? await loadProjectInstructionChain({
          cwd: opts.cwd,
          projectRootMarkers:
            opts.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
          projectDocMaxBytes:
            opts.projectDocMaxBytes ?? DEFAULT_PROJECT_DOC_MAX_BYTES,
        })
      : [];
  const discoveredProjectRoot =
    projectChain[0]?.rootDir ??
    (enabled.has("project") || enabled.has("local")
      ? (await findProjectRoot(
          opts.cwd,
          opts.projectRootMarkers ?? DEFAULT_PROJECT_ROOT_MARKERS,
        ))?.rootDir
      : undefined) ?? resolve(opts.cwd);
  const projectRootDir = discoveredProjectRoot;
  let projectTier: TierEntry | null = null;
  if (enabled.has("project") && projectRootDir !== undefined) {
    const parts: string[] = [];
    const rawParts: string[] = [];
    const dropped: DroppedInclude[] = [];
    const projectDependencies: string[] = [];
    let singleProjectContent = "";
    let singleProjectRaw = "";

    for (const dir of projectInstructionDirectories(projectRootDir, opts.cwd)) {
      const entries = projectChain.filter((entry) => {
        const parent = pathDir(entry.path);
        const owner = parent.endsWith(`${sep}.agenc`) ? pathDir(parent) : parent;
        return resolve(owner) === resolve(dir);
      });
      for (const entry of entries) {
        recordCacheProbe(cacheEvidence, {
          path: entry.canonicalPath,
          identity: entry.identity,
        });
        const resolved = await resolveIncludes(entry.content, {
          baseDir: pathDir(entry.canonicalPath),
          projectRoot: entry.rootDir,
          maxDepth: includeMaxDepth,
          maxBytes: includeMaxBytes,
          includingFile: entry.canonicalPath,
          includingFileSha256: entry.sha256,
          workspaceRoot: entry.rootDir,
          ledger: expansionLedger,
          ...(opts.externalApprovals !== undefined
            ? { externalApprovals: opts.externalApprovals }
            : {}),
        });
        for (const probe of resolved.probes) recordCacheProbe(cacheEvidence, probe);
        dropped.push(...resolved.dropped);
        projectDependencies.push(entry.canonicalPath, ...resolved.included);
        singleProjectContent = resolved.text;
        singleProjectRaw = entry.content;
        parts.push(formatProjectTierChainEntry(entry, resolved.text));
        rawParts.push(formatProjectTierChainEntry(entry, entry.content));
      }
      const ruleBlock = await appendUnconditionalRules(
        "",
        projectRulesDir(dir),
        "Project",
        dir,
        projectDependencies,
        cacheEvidence,
        ruleLedger,
      );
      if (ruleBlock.length > 0) {
        parts.push(ruleBlock);
        rawParts.push(ruleBlock);
      }
    }

    if (parts.length > 0) {
      projectTier = {
        tier: "project",
        path: projectChain.at(-1)?.path ?? projectRulesDir(projectRootDir),
        scopePath: resolve(projectRootDir),
        content:
          parts.length === 1 && projectChain.length === 1
            ? singleProjectContent
            : parts.join("\n\n"),
        rawContent:
          rawParts.length === 1 && projectChain.length === 1
            ? singleProjectRaw
            : rawParts.join("\n\n"),
        dropped,
        dependencies: projectDependencies,
      };
    }
  }

  // Local tier — `<projectRoot>/AGENC.local.md` if a project root was
  // found, otherwise `<cwd>/AGENC.local.md`.
  const localBase = projectRootDir ?? opts.cwd;
  const localPath = join(localBase, LOCAL_INSTRUCTION_FILENAME);
  const local = enabled.has("local") ? await loadTier(
    "local",
    localPath,
    localBase,
    includeMaxDepth,
    includeMaxBytes,
    projectRootDir ?? opts.cwd,
    expansionLedger,
    cacheEvidence,
    opts.externalApprovals,
  ) : null;

  return { managed, user, project: projectTier, local };
}

/**
 * Assemble loaded tiers into one instruction block. Tiers are
 * concatenated with a clear header; missing tiers are skipped silently.
 */
export function assembleTieredInstructions(tiers: TieredInstructions): string {
  const order: InstructionTier[] = ["managed", "user", "project", "local"];
  const parts: string[] = [];
  for (const tier of order) {
    const entry = tiers[tier];
    if (!entry) continue;
    const header = `--- ${tier} (${entry.path}) ---`;
    // Normalize in case assembly happens on in-memory strings that
    // skipped `readTextFile` (unlikely, but cheap insurance per I-80/81).
    parts.push(`${header}\n\n${normalizeExternalText(entry.content).trim()}`);
  }
  const assembled = parts.join("\n\n");
  return Buffer.byteLength(assembled, "utf8") <= DEFAULT_INCLUDE_MAX_BYTES
    ? assembled
    : truncateUtf8Bytes(assembled, DEFAULT_INCLUDE_MAX_BYTES);
}

function formatDroppedInclude(drop: DroppedInclude): string {
  const details = [
    drop.reason,
    `from ${drop.includingFile}`,
    ...(drop.canonicalPath !== undefined
      ? [`target ${drop.canonicalPath}`]
      : []),
    ...(drop.identity !== undefined
      ? [`identity ${instructionFileIdentityKey(drop.identity)}`]
      : []),
  ].join(" ");
  return `AGENC.md include dropped: ${drop.requestedPath} (${details})`;
}

/**
 * Convert rejected `@include` records into user-facing startup/status notices.
 *
 * The loader already preserves rejected include metadata per tier so callers
 * do not need to scrape the assembled prompt's HTML comments. The TUI uses
 * these notices to mirror AgenC's memory/config status surface while
 * keeping AgenC's AGENC.md terminology.
 */
export function formatTieredInstructionWarnings(
  tiers: TieredInstructions,
): readonly string[] {
  const order: InstructionTier[] = ["managed", "user", "project", "local"];
  const warnings: string[] = [];
  for (const tier of order) {
    const entry = tiers[tier];
    if (!entry) continue;
    for (const drop of entry.dropped) {
      warnings.push(formatDroppedInclude(drop));
    }
  }
  return warnings;
}

// Re-exports for convenience — keeps downstream imports single-file.
export { loadProjectInstructions } from "./project-instructions.js";
export type { ProjectInstructions } from "./project-instructions.js";
