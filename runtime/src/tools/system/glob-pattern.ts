/**
 * Pattern semantics for the `Glob` tool.
 *
 * ripgrep lists the candidate files: it owns ignore rules, hidden files, the
 * default excludes and the newest-first order. Its `--type-add` filter, which
 * keeps ignore rules in force, only ever sees a file's name, so a pattern that
 * contains "/" cannot be handed to it whole. `planGlobPattern` therefore
 * splits a pattern into
 *   - a file-name glob that ripgrep applies (the pattern's last segment),
 *   - an optional `--max-depth` bound, and
 *   - a full relative-path matcher for whatever the name filter cannot decide.
 *
 * The matcher reproduces ripgrep's own `--glob` semantics (gitignore line
 * rules over globset with a literal separator):
 *   - a pattern without "/" matches the file name at any depth;
 *   - a pattern with "/" matches the whole path relative to the search root;
 *   - `*` and `?` never match "/", and `?` matches a single byte;
 *   - a `**` path segment matches zero or more directories;
 *   - `[...]` classes, nested `{a,b}` alternatives and `\` escapes follow
 *     globset, including its byte-level treatment of non-ASCII classes.
 * Deliberate differences from ripgrep's `--glob`, all chosen for patterns
 * written by models:
 *   - a leading `./` names the search root, so `./src/*.ts` means `src/*.ts`
 *     (ripgrep's `--glob` matches nothing for it); see `normalizeGlobPattern`;
 *   - on Windows a backslash is a path separator, never an escape;
 *   - a leading `!` or `#` is an ordinary character, where ripgrep reads an
 *     exclusion or a comment.
 * The pattern runs as an automaton over the path's bytes (a lazily built DFA
 * over a Thompson NFA), so matching never backtracks, and both brace nesting
 * and matching work are capped.
 */

export class GlobPatternError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GlobPatternError";
  }
}

/**
 * Thrown when matching needs more automaton work than the matcher allows.
 * Callers stop scanning and report their result as truncated.
 */
export class GlobMatchWorkExceeded extends Error {
  constructor() {
    super("glob matching needed more work than allowed");
    this.name = "GlobMatchWorkExceeded";
  }
}

export interface GlobPathMatcher {
  /**
   * Whether a path relative to the search root (UTF-8, "/" separated)
   * matches. Throws `GlobMatchWorkExceeded` once the matcher's work cap is
   * spent.
   */
  matches(relativePath: Uint8Array): boolean;
}

export interface GlobPatternPlan {
  /** Glob for ripgrep's `--type-add` filter; matched against file names only. */
  readonly nameGlob: string;
  /** Deepest level below the search root a match can sit at (1 = directly in it). */
  readonly maxDepth?: number;
  /** Present when the name filter is not exact: candidates must satisfy it. */
  readonly pathMatcher?: GlobPathMatcher;
  /** Directory-only patterns (a trailing "/") never name a file. */
  readonly matchesNothing?: true;
}

type ClassToken = {
  readonly kind: "class";
  readonly negated: boolean;
  readonly ranges: ReadonlyArray<readonly [string, string]>;
};

type GlobToken =
  | { readonly kind: "literal"; readonly char: string }
  | { readonly kind: "any" }
  | { readonly kind: "zeroOrMore" }
  | { readonly kind: "recursivePrefix" }
  | { readonly kind: "recursiveSuffix" }
  | { readonly kind: "recursiveZeroOrMore" }
  | ClassToken
  | {
      readonly kind: "alternates";
      readonly branches: ReadonlyArray<readonly GlobToken[]>;
    };

interface ParsedGlob {
  readonly tokens: readonly GlobToken[];
  /** The parsed glob text, one entry per character. */
  readonly chars: readonly string[];
  /** For each top-level token, the character offset just after it. */
  readonly topLevelEnds: readonly number[];
}

const SEPARATOR = "/";
const SEPARATOR_BYTE = 0x2f;
/**
 * Brace groups may nest this deep. Real patterns use one or two levels; the
 * bound keeps every recursive step below far from the stack limit.
 */
const MAX_ALTERNATE_NESTING = 32;
/**
 * Default cap on automaton construction work (NFA states visited while
 * building DFA states) for one matcher. Real patterns build a few dozen DFA
 * states and stay far below it.
 */
const DEFAULT_MAX_MATCH_WORK = 100_000_000;
/** Cached DFA states before the cache is dropped and rebuilt on demand. */
const MAX_DFA_STATES = 4_096;
const DFA_UNKNOWN = -1;
const DFA_DEAD = -2;

function isSeparator(char: string | undefined): boolean {
  return char === SEPARATOR;
}

/**
 * A port of globset's parser as ripgrep 15 ships it: nested alternates, the
 * `**` rules, classes without escapes, `\` escapes elsewhere. Error texts
 * match globset, so a malformed path pattern reads the same as a malformed
 * name pattern that ripgrep reports itself.
 */
class GlobParser {
  private readonly chars: readonly string[];
  private index = 0;
  private previous: string | undefined;
  private current: string | undefined;
  private readonly branches: GlobToken[][] = [[]];
  private readonly alternateStarts: number[] = [];
  private readonly topLevelEnds: number[] = [];

  /** `glob` is parsed; `reportedGlob` is what error messages name. */
  constructor(
    glob: string,
    private readonly reportedGlob: string,
  ) {
    this.chars = Array.from(glob);
  }

  parse(): ParsedGlob {
    for (;;) {
      const char = this.bump();
      if (char === undefined) break;
      switch (char) {
        case "?":
          this.push({ kind: "any" });
          break;
        case "*":
          this.parseStar();
          break;
        case "[":
          this.parseClass();
          break;
        case "{":
          if (this.alternateStarts.length >= MAX_ALTERNATE_NESTING) {
            throw this.error(
              `alternate groups nest deeper than ${MAX_ALTERNATE_NESTING} levels`,
            );
          }
          this.alternateStarts.push(this.branches.length);
          this.branches.push([]);
          break;
        case "}":
          this.popAlternate();
          break;
        case ",":
          if (this.alternateStarts.length === 0) {
            this.push({ kind: "literal", char });
          } else {
            this.branches.push([]);
          }
          break;
        case "\\": {
          const escaped = this.bump();
          if (escaped === undefined) throw this.error("dangling '\\'");
          this.push({ kind: "literal", char: escaped });
          break;
        }
        default:
          this.push({ kind: "literal", char });
      }
    }
    if (this.branches.length > 1) {
      throw this.error(
        "unclosed alternate group; missing '}' (maybe escape '{' with '[{]'?)",
      );
    }
    return {
      tokens: this.branches[0] as GlobToken[],
      chars: this.chars,
      topLevelEnds: this.topLevelEnds,
    };
  }

  private error(message: string): GlobPatternError {
    return new GlobPatternError(
      `error parsing glob '${this.reportedGlob}': ${message}`,
    );
  }

  private bump(): string | undefined {
    this.previous = this.current;
    this.current = this.chars[this.index];
    if (this.current !== undefined) this.index += 1;
    return this.current;
  }

  private peek(): string | undefined {
    return this.chars[this.index];
  }

  private get branch(): GlobToken[] {
    return this.branches[this.branches.length - 1] as GlobToken[];
  }

  private push(token: GlobToken): void {
    this.branch.push(token);
    if (this.branches.length === 1) this.topLevelEnds.push(this.index);
  }

  private pop(): GlobToken | undefined {
    if (this.branches.length === 1) this.topLevelEnds.pop();
    return this.branch.pop();
  }

  private popAlternate(): void {
    const start = this.alternateStarts.pop();
    if (start === undefined) {
      throw this.error(
        "unopened alternate group; missing '{' (maybe escape '}' with '[}]'?)",
      );
    }
    const branches = this.branches.splice(start);
    this.push({ kind: "alternates", branches });
  }

  private pushTwoStars(): void {
    this.push({ kind: "zeroOrMore" });
    this.push({ kind: "zeroOrMore" });
  }

  private parseStar(): void {
    const previous = this.previous;
    if (this.peek() !== "*") {
      this.push({ kind: "zeroOrMore" });
      return;
    }
    this.bump();
    if (this.branch.length === 0) {
      const next = this.peek();
      if (next !== undefined && !isSeparator(next)) {
        this.pushTwoStars();
      } else {
        this.bump();
        this.push({ kind: "recursivePrefix" });
      }
      return;
    }
    if (
      !isSeparator(previous) &&
      (this.alternateStarts.length === 0 ||
        (previous !== "," && previous !== "{"))
    ) {
      this.pushTwoStars();
      return;
    }
    const next = this.peek();
    let isSuffix: boolean;
    if (next === undefined) {
      isSuffix = true;
    } else if (
      (next === "," || next === "}") &&
      this.alternateStarts.length > 0
    ) {
      isSuffix = true;
    } else if (isSeparator(next)) {
      this.bump();
      isSuffix = false;
    } else {
      this.pushTwoStars();
      return;
    }
    const replaced = this.pop();
    if (
      replaced?.kind === "recursivePrefix" ||
      replaced?.kind === "recursiveSuffix"
    ) {
      this.push({ kind: replaced.kind });
    } else {
      this.push({
        kind: isSuffix ? "recursiveSuffix" : "recursiveZeroOrMore",
      });
    }
  }

  private parseClass(): void {
    const ranges: Array<[string, string]> = [];
    const next = this.peek();
    const negated = next === "!" || next === "^";
    if (negated) this.bump();
    let first = true;
    let inRange = false;
    for (;;) {
      const char = this.bump();
      if (char === undefined) {
        throw this.error("unclosed character class; missing ']'");
      }
      if (char === "]" && !first) break;
      if (char === "]") {
        ranges.push(["]", "]"]);
      } else if (char === "-" && first) {
        ranges.push(["-", "-"]);
      } else if (char === "-" && !inRange) {
        inRange = true;
      } else if (inRange) {
        const range = ranges[ranges.length - 1] as [string, string];
        range[1] = char;
        if (
          (char.codePointAt(0) as number) < (range[0].codePointAt(0) as number)
        ) {
          throw this.error(`invalid range; '${range[0]}' > '${char}'`);
        }
        inRange = false;
      } else {
        ranges.push([char, char]);
      }
      first = false;
    }
    if (inRange) ranges.push(["-", "-"]);
    this.push({ kind: "class", negated, ranges });
  }
}

function utf8Bytes(char: string): Uint8Array {
  return Buffer.from(char, "utf8");
}

/**
 * globset writes each class endpoint as its UTF-8 bytes inside a byte-mode
 * regex class, so `[é]` is the byte set {0xc3, 0xa9} and a range joins the
 * last byte of its start to the first byte of its end.
 */
function classMask(token: ClassToken): Uint8Array {
  const mask = new Uint8Array(256);
  for (const [start, end] of token.ranges) {
    const startBytes = utf8Bytes(start);
    if (start === end) {
      for (const byte of startBytes) mask[byte] = 1;
      continue;
    }
    const endBytes = utf8Bytes(end);
    for (const byte of startBytes.subarray(0, startBytes.length - 1)) {
      mask[byte] = 1;
    }
    const low = startBytes[startBytes.length - 1] as number;
    const high = endBytes[0] as number;
    for (let byte = low; byte <= high; byte += 1) mask[byte] = 1;
    for (const byte of endBytes.subarray(1)) mask[byte] = 1;
  }
  if (token.negated) {
    for (let byte = 0; byte < 256; byte += 1) {
      mask[byte] = mask[byte] === 1 ? 0 : 1;
    }
  }
  return mask;
}

/** True when the token can consume a "/" of the path. */
function canMatchSeparator(token: GlobToken): boolean {
  switch (token.kind) {
    case "literal":
      return token.char === SEPARATOR;
    case "any":
    case "zeroOrMore":
      return false;
    case "recursivePrefix":
    case "recursiveSuffix":
    case "recursiveZeroOrMore":
      return true;
    case "class":
      return classMask(token)[SEPARATOR_BYTE] === 1;
    case "alternates":
      return token.branches.some((branch) => branch.some(canMatchSeparator));
  }
}

/** globset drops alternatives whose regex is empty, e.g. the empty one in `{,a}`. */
function compilesToEmpty(tokens: readonly GlobToken[]): boolean {
  return tokens.every(
    (token) =>
      token.kind === "alternates" && token.branches.every(compilesToEmpty),
  );
}

const NFA_BYTE = 0;
const NFA_SPLIT = 1;
const NFA_MATCH = 2;

const BYTE_MASKS: readonly Uint8Array[] = Array.from(
  { length: 256 },
  (_, byte) => {
    const mask = new Uint8Array(256);
    mask[byte] = 1;
    return mask;
  },
);
const ANY_BYTE_MASK = new Uint8Array(256).fill(1);
const NON_SEPARATOR_MASK = (() => {
  const mask = new Uint8Array(256).fill(1);
  mask[SEPARATOR_BYTE] = 0;
  return mask;
})();
const SEPARATOR_MASK = BYTE_MASKS[SEPARATOR_BYTE] as Uint8Array;

/**
 * Automaton for one glob over path bytes. The Thompson NFA mirrors globset's
 * regex translation: `?` is `[^/]`, `*` is `[^/]*`, and the three recursive
 * forms are `(?:/?|.*\/)`, `/.*` and `(?:/|/.*\/)`, where `.` also matches a
 * newline byte. Matching walks a DFA whose states (sets of NFA states) and
 * transitions are built on first use, so each path byte costs one table
 * lookup once the few states a pattern needs exist.
 */
class GlobAutomaton implements GlobPathMatcher {
  private readonly kinds: number[] = [];
  private readonly masks: Array<Uint8Array | undefined> = [];
  private readonly nexts: number[] = [];
  private readonly outs: Array<number[] | undefined> = [];
  private readonly start: number;
  private readonly seen: Uint32Array;
  private stamp = 0;
  private work = 0;
  private dfaSets: number[][] = [];
  private dfaAccepts: boolean[] = [];
  private dfaTransitions: Int32Array[] = [];
  private dfaIds = new Map<string, number>();
  private dfaStart = DFA_UNKNOWN;
  private dfaGeneration = 0;

  constructor(
    tokens: readonly GlobToken[],
    private readonly maxWork: number,
  ) {
    const match = this.state(NFA_MATCH);
    // globset special-cases a glob that is only `**`: it matches everything.
    this.start =
      tokens.length === 1 && tokens[0]?.kind === "recursivePrefix"
        ? this.star(ANY_BYTE_MASK, match)
        : this.sequence(tokens, match);
    this.seen = new Uint32Array(this.kinds.length);
  }

  matches(relativePath: Uint8Array): boolean {
    if (this.dfaStart === DFA_UNKNOWN) {
      this.dfaStart = this.intern(this.closure([this.start]));
    }
    let state = this.dfaStart;
    if (state === DFA_DEAD) return false;
    for (let index = 0; index < relativePath.length; index += 1) {
      const byte = relativePath[index] as number;
      let next = (this.dfaTransitions[state] as Int32Array)[byte] as number;
      if (next === DFA_UNKNOWN) next = this.transition(state, byte);
      if (next === DFA_DEAD) return false;
      state = next;
    }
    return this.dfaAccepts[state] === true;
  }

  /** Build (and cache) the DFA transition from `state` on `byte`. */
  private transition(state: number, byte: number): number {
    const seeds: number[] = [];
    const set = this.dfaSets[state] as number[];
    this.charge(set.length);
    for (const nfaState of set) {
      if (
        this.kinds[nfaState] === NFA_BYTE &&
        (this.masks[nfaState] as Uint8Array)[byte] === 1
      ) {
        seeds.push(this.nexts[nfaState] as number);
      }
    }
    const generation = this.dfaGeneration;
    const next = this.intern(this.closure(seeds));
    // Interning may have dropped the cache, and `state` with it.
    if (generation === this.dfaGeneration) {
      (this.dfaTransitions[state] as Int32Array)[byte] = next;
    }
    return next;
  }

  /** Sorted byte and match states reachable from `seeds` over split edges. */
  private closure(seeds: readonly number[]): number[] {
    this.stamp += 1;
    if (this.stamp === 0xffffffff) {
      this.seen.fill(0);
      this.stamp = 1;
    }
    const pending = [...seeds];
    const reached: number[] = [];
    while (pending.length > 0) {
      const state = pending.pop() as number;
      if (this.seen[state] === this.stamp) continue;
      this.seen[state] = this.stamp;
      this.charge(1);
      if (this.kinds[state] === NFA_SPLIT) {
        const outs = this.outs[state] as number[];
        for (let index = outs.length - 1; index >= 0; index -= 1) {
          pending.push(outs[index] as number);
        }
      } else {
        reached.push(state);
      }
    }
    return reached.sort((left, right) => left - right);
  }

  private intern(set: number[]): number {
    if (set.length === 0) return DFA_DEAD;
    const key = set.join(",");
    const known = this.dfaIds.get(key);
    if (known !== undefined) return known;
    if (this.dfaSets.length >= MAX_DFA_STATES) {
      this.dfaSets = [];
      this.dfaAccepts = [];
      this.dfaTransitions = [];
      this.dfaIds = new Map();
      this.dfaStart = DFA_UNKNOWN;
      this.dfaGeneration += 1;
    }
    const id = this.dfaSets.length;
    this.dfaSets.push(set);
    this.dfaAccepts.push(set.some((state) => this.kinds[state] === NFA_MATCH));
    this.dfaTransitions.push(new Int32Array(256).fill(DFA_UNKNOWN));
    this.dfaIds.set(key, id);
    return id;
  }

  private charge(units: number): void {
    this.work += units;
    if (this.work > this.maxWork) throw new GlobMatchWorkExceeded();
  }

  private state(kind: number): number {
    this.kinds.push(kind);
    this.masks.push(undefined);
    this.nexts.push(-1);
    this.outs.push(undefined);
    return this.kinds.length - 1;
  }

  private byte(mask: Uint8Array, next: number): number {
    const state = this.state(NFA_BYTE);
    this.masks[state] = mask;
    this.nexts[state] = next;
    return state;
  }

  private split(outs: number[]): number {
    const state = this.state(NFA_SPLIT);
    this.outs[state] = outs;
    return state;
  }

  private star(mask: Uint8Array, next: number): number {
    const loop = this.split([]);
    this.outs[loop] = [this.byte(mask, loop), next];
    return loop;
  }

  private sequence(tokens: readonly GlobToken[], next: number): number {
    let state = next;
    for (let index = tokens.length - 1; index >= 0; index -= 1) {
      state = this.token(tokens[index] as GlobToken, state);
    }
    return state;
  }

  private token(token: GlobToken, next: number): number {
    switch (token.kind) {
      case "literal": {
        const bytes = utf8Bytes(token.char);
        let state = next;
        for (let index = bytes.length - 1; index >= 0; index -= 1) {
          state = this.byte(
            BYTE_MASKS[bytes[index] as number] as Uint8Array,
            state,
          );
        }
        return state;
      }
      case "any":
        return this.byte(NON_SEPARATOR_MASK, next);
      case "zeroOrMore":
        return this.star(NON_SEPARATOR_MASK, next);
      case "recursivePrefix":
        return this.split([
          this.split([this.byte(SEPARATOR_MASK, next), next]),
          this.star(ANY_BYTE_MASK, this.byte(SEPARATOR_MASK, next)),
        ]);
      case "recursiveSuffix":
        return this.byte(SEPARATOR_MASK, this.star(ANY_BYTE_MASK, next));
      case "recursiveZeroOrMore":
        return this.split([
          this.byte(SEPARATOR_MASK, next),
          this.byte(
            SEPARATOR_MASK,
            this.star(ANY_BYTE_MASK, this.byte(SEPARATOR_MASK, next)),
          ),
        ]);
      case "class":
        return this.byte(classMask(token), next);
      case "alternates": {
        const starts = token.branches
          .filter((branch) => !compilesToEmpty(branch))
          .map((branch) => this.sequence(branch, next));
        if (starts.length === 0) return next;
        if (starts.length === 1) return starts[0] as number;
        return this.split(starts);
      }
    }
  }
}

interface CompiledGlob {
  readonly parsed: ParsedGlob;
  readonly matcher: GlobPathMatcher;
  readonly onlyDirectories: boolean;
}

const MATCHES_NOTHING: GlobPathMatcher = { matches: () => false };

export interface GlobMatcherOptions {
  /** Cap on automaton construction work (default {@link DEFAULT_MAX_MATCH_WORK}). */
  readonly maxWork?: number;
}

/**
 * Compile a pattern exactly as ripgrep compiles a `--glob` (the gitignore
 * line rules, then globset), except that a leading `!` or `#` stays literal:
 * Glob searches for files and has no exclusions or comments.
 */
function compileGlob(
  pattern: string,
  options: GlobMatcherOptions = {},
): CompiledGlob {
  let line = pattern;
  let anchored = false;
  if (line.startsWith("/")) {
    line = line.slice(1);
    anchored = true;
  }
  let onlyDirectories = false;
  if (line.endsWith("/")) {
    onlyDirectories = true;
    line = line.slice(0, -1);
    if (line.endsWith("\\")) line = line.slice(0, -1);
  }
  let glob = line;
  if (
    !anchored &&
    !line.includes("/") &&
    !(line.startsWith("**/") || line === "**")
  ) {
    glob = `**/${glob}`;
  }
  if (glob.endsWith("/**")) glob = `${glob}/*`;
  const parsed = new GlobParser(glob, pattern).parse();
  return {
    parsed,
    matcher: onlyDirectories
      ? MATCHES_NOTHING
      : new GlobAutomaton(
          parsed.tokens,
          options.maxWork ?? DEFAULT_MAX_MATCH_WORK,
        ),
    onlyDirectories,
  };
}

/**
 * Compile a full relative-path matcher with ripgrep `--glob` semantics.
 * `matches` throws `GlobMatchWorkExceeded` once the work cap is spent.
 */
export function compileGlobMatcher(
  pattern: string,
  options: GlobMatcherOptions = {},
): GlobPathMatcher {
  return compileGlob(pattern, options).matcher;
}

/**
 * Put a pattern in the "/"-separated form ripgrep globs use. On Windows a
 * backslash is a path separator (globset's own Windows default); elsewhere it
 * stays an escape.
 *
 * A leading `./` names the search root, so it is dropped and the rest stays
 * anchored there. This is a deliberate difference from ripgrep, whose
 * `--glob './src/*.ts'` matches nothing: models often write paths that way,
 * and a silent empty result is the failure this module exists to prevent.
 */
export function normalizeGlobPattern(
  pattern: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const separated =
    platform === "win32" ? pattern.replace(/\\/gu, "/") : pattern;
  const stripped = separated.replace(/^(?:\.\/)+/u, "");
  if (stripped === separated || stripped.length === 0) return separated;
  return stripped.includes("/") ? stripped : `/${stripped}`;
}

/** True for tokens that end exactly at a "/" of the path. */
function endsAtSeparator(token: GlobToken): boolean {
  return (
    (token.kind === "literal" && token.char === SEPARATOR) ||
    token.kind === "recursivePrefix" ||
    token.kind === "recursiveSuffix" ||
    token.kind === "recursiveZeroOrMore"
  );
}

/**
 * Plan how Glob evaluates a normalized pattern (see `normalizeGlobPattern`).
 * Throws `GlobPatternError` for a malformed pattern.
 */
export function planGlobPattern(
  pattern: string,
  options: GlobMatcherOptions = {},
): GlobPatternPlan {
  // Without a "/" the pattern names files at any depth, which is exactly
  // ripgrep's file-name filter. That path is unchanged.
  if (!pattern.includes("/")) return { nameGlob: pattern };

  const compiled = compileGlob(pattern, options);
  if (compiled.onlyDirectories) return { nameGlob: "*", matchesNothing: true };
  const { tokens, chars, topLevelEnds } = compiled.parsed;
  if (tokens.length === 1 && tokens[0]?.kind === "recursivePrefix") {
    return { nameGlob: "*" };
  }

  // The tokens after the last top-level "/" match the file name. When none of
  // them can match a "/", ripgrep's name filter can pre-select candidates with
  // them (it cannot carry a ":", which splits its `--type-add` argument).
  let nameTokenStart = 0;
  let nameCharStart = 0;
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    if (endsAtSeparator(tokens[index] as GlobToken)) {
      nameTokenStart = index + 1;
      nameCharStart = topLevelEnds[index] as number;
      break;
    }
  }
  const nameTokens = tokens.slice(nameTokenStart);
  const nameSource = chars.slice(nameCharStart).join("");
  const nameIsSegment =
    nameTokens.length > 0 &&
    !nameTokens.some(canMatchSeparator) &&
    !nameSource.includes(":");

  // `**/NAME` is a pure name match at any depth: the name filter is exact.
  if (
    nameIsSegment &&
    nameTokenStart === 1 &&
    tokens[0]?.kind === "recursivePrefix"
  ) {
    return { nameGlob: nameSource };
  }

  // When only literal "/" tokens can match a separator, every match sits at
  // exactly one depth.
  let separators = 0;
  let fixedDepth = true;
  for (const token of tokens) {
    if (token.kind === "literal" && token.char === SEPARATOR) {
      separators += 1;
    } else if (canMatchSeparator(token)) {
      fixedDepth = false;
      break;
    }
  }
  return {
    nameGlob: nameIsSegment ? nameSource : "*",
    ...(fixedDepth ? { maxDepth: separators + 1 } : {}),
    pathMatcher: compiled.matcher,
  };
}
