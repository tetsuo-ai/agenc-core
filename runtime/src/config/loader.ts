// T10 Group D — TOML loader for ~/.agenc/config.toml.
//
// Uses an inline minimal TOML-subset parser to avoid a new npm dep.
// Supported:
//   - Line comments (`#`)
//   - Tables:             [section]
//   - Subtables:          [section.sub]
//   - Array-of-tables:    [[profiles.foo]]
//   - Basic strings:      "value"         (with escapes \n, \t, \r, \\, \")
//   - Literal strings:    'value'         (no escapes)
//   - Integers:           42, -7, 1_000
//   - Floats:             3.14, 1.0e6
//   - Booleans:           true, false
//   - Arrays of strings / numbers / booleans (single-line)
//   - Dotted-key assignment (`a.b.c = 1` → nested table)
//   - Inline tables:      { a = 1, b = "x" }
//
// Not supported (documented as out-of-scope):
//   - Multi-line strings / arrays
//   - Date-time values
//   - Hex/octal/binary integers
//
// branding-scan: allow upstream runtime compatibility reference
// This is enough for AgenC's config surface (codex runtime + AgenC fields).
// Unknown TOML values are still parsed and surfaced to the caller via
// `normalizeRawConfig` (→ `_unknown` side-table).
//
// Duplicate-key handling (TOML 1.0 §6):
//   TOML strictly forbids redefining a key or redeclaring a non-array-of-
//   tables table. AgenC's posture is "don't hard-fail on config", so the
//   parser intentionally adopts lenient-with-warn semantics: duplicate
//   assignments and table redefinitions are accepted as last-write-wins,
//   and the optional `onDuplicateKey` callback fires with the fully-
//   qualified key path plus the previous/new values. Callers (loadConfig,
//   ConfigStore) thread an `onWarn` sink down so operator-visible
//   warnings surface without aborting boot. Default callback is a no-op
//   so the parser remains usable outside the runtime.
//
// I-81: every utf8 file read at a runtime boundary routes through
// `utils/file-read.ts::readTextFile` so UTF-8 BOM is stripped and line
// endings are normalized before parsing; loadConfig below uses that
// helper instead of a raw `fs.readFile` to preserve the invariant.

import { resolve as pathResolve } from "node:path";
import type { AgenCConfig } from "./schema.js";
import {
  defaultConfig,
  mergeConfigs,
  normalizeAgenCKeyAliases,
  normalizeRawConfig,
  validateAgenCConfigBlocks,
} from "./schema.js";
import { resolveAgencHome } from "./env.js";
import { readTextFile } from "./_deps/file-read.js";
import { migrateRawAgenCConfig } from "../state/migrations/config-migrations.js";
import { runConfigFileMigrations } from "./migrate.js";

// ─────────────────────────────────────────────────────────────────────
// Parser
// ─────────────────────────────────────────────────────────────────────

type TomlValue =
  | string
  | number
  | boolean
  | TomlValue[]
  | { [key: string]: TomlValue };

export class TomlParseError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`TOML parse error at line ${line}: ${message}`);
    this.name = "TomlParseError";
    this.line = line;
  }
}

/**
 * Fired on duplicate-key assignment or table redefinition. `key` is the
 * fully qualified dotted path (e.g. `"mcp_servers.github.command"`);
 * `previousValue` / `newValue` are the pre- and post-write values.
 * Lenient-with-warn (see file header): the parser keeps last-write-wins,
 * so `newValue` is what lands in the parsed tree.
 */
export interface TomlDuplicateKeyWarning {
  readonly key: string;
  readonly previousValue: TomlValue;
  readonly newValue: TomlValue;
  readonly line: number;
}

export type TomlDuplicateKeyHandler = (
  warning: TomlDuplicateKeyWarning,
) => void;

interface ParseState {
  src: string;
  pos: number;
  line: number;
  onDuplicateKey: TomlDuplicateKeyHandler;
}

function newState(
  src: string,
  onDuplicateKey: TomlDuplicateKeyHandler = () => {
    /* lenient-with-warn default: no-op. */
  },
): ParseState {
  return { src, pos: 0, line: 1, onDuplicateKey };
}

function peek(s: ParseState, ahead = 0): string {
  return s.src[s.pos + ahead] ?? "";
}

function advance(s: ParseState, n = 1): void {
  for (let i = 0; i < n; i += 1) {
    if (s.src[s.pos] === "\n") s.line += 1;
    s.pos += 1;
  }
}

function skipWhitespaceInline(s: ParseState): void {
  while (s.pos < s.src.length) {
    const c = s.src[s.pos]!;
    if (c === " " || c === "\t") {
      s.pos += 1;
    } else {
      break;
    }
  }
}

function skipLine(s: ParseState): void {
  while (s.pos < s.src.length && s.src[s.pos] !== "\n") s.pos += 1;
  if (s.src[s.pos] === "\n") advance(s);
}

function atEol(s: ParseState): boolean {
  skipWhitespaceInline(s);
  const c = peek(s);
  return c === "" || c === "\n" || c === "#" || c === "\r";
}

// Key segments that would walk into the prototype chain when a parsed table is
// assigned with `cur[seg] = …`. `__proto__` is the concrete pollution vector
// (`cur["__proto__"]` reads/writes Object.prototype); `constructor`/`prototype`
// are rejected too so no gadget chain can reach a constructor's prototype. Every
// path-building site (dotted keys, `[table]` / `[[array]]` headers, inline
// tables — quoted forms included) funnels through parseKey, so guarding here
// covers them all.
const FORBIDDEN_KEY_SEGMENTS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

function parseKey(s: ParseState): string[] {
  // Dotted keys → returns path segments.
  const parts: string[] = [];
  while (true) {
    skipWhitespaceInline(s);
    const segment = parseKeySegment(s);
    if (FORBIDDEN_KEY_SEGMENTS.has(segment)) {
      throw new TomlParseError(
        `disallowed key segment "${segment}" (prototype-pollution guard)`,
        s.line,
      );
    }
    parts.push(segment);
    skipWhitespaceInline(s);
    if (peek(s) === ".") {
      advance(s);
      continue;
    }
    break;
  }
  return parts;
}

function parseKeySegment(s: ParseState): string {
  const c = peek(s);
  if (c === '"' || c === "'") {
    return parseString(s);
  }
  const start = s.pos;
  while (s.pos < s.src.length) {
    const ch = s.src[s.pos]!;
    if (
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "_" ||
      ch === "-"
    ) {
      s.pos += 1;
    } else {
      break;
    }
  }
  if (s.pos === start) {
    throw new TomlParseError(`expected key segment, got "${c}"`, s.line);
  }
  return s.src.slice(start, s.pos);
}

function parseString(s: ParseState): string {
  const quote = s.src[s.pos];
  if (quote !== '"' && quote !== "'") {
    throw new TomlParseError(`expected string, got "${quote}"`, s.line);
  }
  advance(s); // opening quote
  let out = "";
  while (s.pos < s.src.length) {
    const c = s.src[s.pos]!;
    if (c === quote) {
      advance(s); // closing quote
      return out;
    }
    if (c === "\n") {
      throw new TomlParseError("unterminated string (newline)", s.line);
    }
    if (quote === '"' && c === "\\") {
      const next = s.src[s.pos + 1];
      if (next === undefined) {
        throw new TomlParseError("trailing backslash in string", s.line);
      }
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "\t";
          break;
        case "r":
          out += "\r";
          break;
        case "\\":
          out += "\\";
          break;
        case '"':
          out += '"';
          break;
        case "/":
          out += "/";
          break;
        default:
          out += next;
      }
      advance(s, 2);
      continue;
    }
    out += c;
    advance(s);
  }
  throw new TomlParseError("unterminated string", s.line);
}

function parseNumber(s: ParseState): number {
  const start = s.pos;
  if (peek(s) === "+" || peek(s) === "-") advance(s);
  while (s.pos < s.src.length) {
    const c = s.src[s.pos]!;
    if (
      (c >= "0" && c <= "9") ||
      c === "_" ||
      c === "." ||
      c === "e" ||
      c === "E" ||
      c === "+" ||
      c === "-"
    ) {
      s.pos += 1;
    } else {
      break;
    }
  }
  const raw = s.src.slice(start, s.pos).replace(/_/g, "");
  if (raw.length === 0) {
    throw new TomlParseError("expected number", s.line);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new TomlParseError(`invalid number "${raw}"`, s.line);
  }
  return n;
}

function parseBool(s: ParseState): boolean {
  if (s.src.startsWith("true", s.pos)) {
    advance(s, 4);
    return true;
  }
  if (s.src.startsWith("false", s.pos)) {
    advance(s, 5);
    return false;
  }
  throw new TomlParseError("expected bool", s.line);
}

function parseValue(s: ParseState): TomlValue {
  skipWhitespaceInline(s);
  const c = peek(s);
  if (c === '"' || c === "'") return parseString(s);
  if (c === "t" || c === "f") return parseBool(s);
  if (c === "[") return parseArray(s);
  if (c === "{") return parseInlineTable(s);
  if (
    c === "-" ||
    c === "+" ||
    (c >= "0" && c <= "9")
  ) {
    return parseNumber(s);
  }
  throw new TomlParseError(`unexpected value char "${c}"`, s.line);
}

function parseArray(s: ParseState): TomlValue[] {
  advance(s); // [
  const out: TomlValue[] = [];
  while (s.pos < s.src.length) {
    skipWhitespaceInlineAndComments(s);
    if (peek(s) === "]") {
      advance(s);
      return out;
    }
    out.push(parseValue(s));
    skipWhitespaceInlineAndComments(s);
    if (peek(s) === ",") {
      advance(s);
      continue;
    }
    if (peek(s) === "]") {
      advance(s);
      return out;
    }
    throw new TomlParseError(
      `expected ',' or ']' in array, got "${peek(s)}"`,
      s.line,
    );
  }
  throw new TomlParseError("unterminated array", s.line);
}

function skipWhitespaceInlineAndComments(s: ParseState): void {
  while (s.pos < s.src.length) {
    const c = s.src[s.pos]!;
    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      if (c === "\n") s.line += 1;
      s.pos += 1;
    } else if (c === "#") {
      while (s.pos < s.src.length && s.src[s.pos] !== "\n") s.pos += 1;
    } else {
      break;
    }
  }
}

function parseInlineTable(
  s: ParseState,
): { [key: string]: TomlValue } {
  advance(s); // {
  const out: { [key: string]: TomlValue } = {};
  while (s.pos < s.src.length) {
    skipWhitespaceInline(s);
    if (peek(s) === "}") {
      advance(s);
      return out;
    }
    const keyPath = parseKey(s);
    skipWhitespaceInline(s);
    if (peek(s) !== "=") {
      throw new TomlParseError("expected '=' in inline table", s.line);
    }
    advance(s);
    const value = parseValue(s);
    setNested(s, out, keyPath, value, keyPath);
    skipWhitespaceInline(s);
    if (peek(s) === ",") {
      advance(s);
      continue;
    }
    if (peek(s) === "}") {
      advance(s);
      return out;
    }
    throw new TomlParseError(
      `expected ',' or '}' in inline table, got "${peek(s)}"`,
      s.line,
    );
  }
  throw new TomlParseError("unterminated inline table", s.line);
}

/**
 * Assign `value` at `path` inside `root`. On leaf collision (duplicate
 * key assignment) the previous value is overwritten last-write-wins and
 * `s.onDuplicateKey` is fired with the fully-qualified dotted path
 * joined from `qualifiedPath` (caller-supplied so warnings carry the
 * absolute path — e.g. `mcp_servers.github.command` — rather than a
 * table-local slice). Intermediate path collisions with a non-table
 * value still throw `TomlParseError` because overwriting a scalar with
 * a table would silently reshape the document.
 */
function setNested(
  s: ParseState,
  root: Record<string, TomlValue>,
  path: string[],
  value: TomlValue,
  qualifiedPath: string[],
): void {
  let cur: Record<string, TomlValue> = root;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i]!;
    const next = cur[seg];
    if (next === undefined) {
      const fresh: Record<string, TomlValue> = {};
      cur[seg] = fresh;
      cur = fresh;
    } else if (
      typeof next === "object" &&
      next !== null &&
      !Array.isArray(next)
    ) {
      cur = next as Record<string, TomlValue>;
    } else {
      throw new TomlParseError(
        `key path collision at "${path.slice(0, i + 1).join(".")}"`,
        s.line,
      );
    }
  }
  const leaf = path[path.length - 1]!;
  if (Object.prototype.hasOwnProperty.call(cur, leaf)) {
    const previousValue = cur[leaf]!;
    s.onDuplicateKey({
      key: qualifiedPath.join("."),
      previousValue,
      newValue: value,
      line: s.line,
    });
  }
  cur[leaf] = value;
}

function ensureTablePath(
  root: Record<string, TomlValue>,
  path: string[],
  line: number,
): Record<string, TomlValue> {
  let cur: Record<string, TomlValue> = root;
  for (const seg of path) {
    const next = cur[seg];
    if (next === undefined) {
      const fresh: Record<string, TomlValue> = {};
      cur[seg] = fresh;
      cur = fresh;
    } else if (
      typeof next === "object" &&
      next !== null &&
      !Array.isArray(next)
    ) {
      cur = next as Record<string, TomlValue>;
    } else {
      throw new TomlParseError(
        `table path "${path.join(".")}" collides with existing value`,
        line,
      );
    }
  }
  return cur;
}

function ensureArrayOfTables(
  root: Record<string, TomlValue>,
  path: string[],
  line: number,
): Record<string, TomlValue> {
  if (path.length === 0) {
    throw new TomlParseError("empty array-of-tables header", line);
  }
  const parent = ensureTablePath(root, path.slice(0, -1), line);
  const last = path[path.length - 1]!;
  const existing = parent[last];
  let arr: TomlValue[];
  if (existing === undefined) {
    arr = [];
    parent[last] = arr;
  } else if (Array.isArray(existing)) {
    arr = existing;
  } else {
    throw new TomlParseError(
      `array-of-tables "${path.join(".")}" collides with existing value`,
      line,
    );
  }
  const fresh: Record<string, TomlValue> = {};
  arr.push(fresh);
  return fresh;
}

export interface ParseTomlOptions {
  /**
   * Fires on duplicate key assignment or `[header]` table redeclaration.
   * Lenient-with-warn semantics (see file header): the duplicate is
   * accepted last-write-wins; this callback surfaces the collision so
   * the caller can emit an operator-visible warning.
   */
  readonly onDuplicateKey?: TomlDuplicateKeyHandler;
}

export function parseToml(
  src: string,
  options?: ParseTomlOptions,
): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  const s = newState(src, options?.onDuplicateKey);
  let currentTable = root;
  // Path prefix of the currently-selected table, tracked so duplicate-
  // key warnings fired from `setNested` carry a fully-qualified dotted
  // path (`mcp_servers.github.command`) instead of a table-local slice.
  let currentTablePath: string[] = [];
  // Tracks `[header]` tables declared explicitly so a second
  // declaration of the same table header fires the duplicate-key
  // warning. Implicit intermediate tables created by dotted
  // keys/headers don't count as a declaration.
  const declaredTables = new Set<string>();

  while (s.pos < s.src.length) {
    // Skip leading whitespace / blank lines / comments.
    while (s.pos < s.src.length) {
      const c = s.src[s.pos]!;
      if (c === " " || c === "\t") {
        s.pos += 1;
      } else if (c === "\n" || c === "\r") {
        if (c === "\n") s.line += 1;
        s.pos += 1;
      } else if (c === "#") {
        skipLine(s);
      } else {
        break;
      }
    }
    if (s.pos >= s.src.length) break;

    const c = peek(s);

    // Array-of-tables: [[path]]
    if (c === "[" && peek(s, 1) === "[") {
      advance(s, 2);
      skipWhitespaceInline(s);
      const path = parseKey(s);
      skipWhitespaceInline(s);
      if (peek(s) !== "]" || peek(s, 1) !== "]") {
        throw new TomlParseError("expected ']]' for array-of-tables", s.line);
      }
      advance(s, 2);
      skipWhitespaceInline(s);
      if (!atEol(s)) {
        throw new TomlParseError("trailing content after ']]'", s.line);
      }
      skipLine(s);
      currentTable = ensureArrayOfTables(root, path, s.line);
      currentTablePath = path;
      continue;
    }

    // Table header: [path]
    if (c === "[") {
      advance(s);
      skipWhitespaceInline(s);
      const path = parseKey(s);
      skipWhitespaceInline(s);
      if (peek(s) !== "]") {
        throw new TomlParseError("expected ']' for table header", s.line);
      }
      advance(s);
      skipWhitespaceInline(s);
      if (!atEol(s)) {
        throw new TomlParseError("trailing content after ']'", s.line);
      }
      skipLine(s);
      const qualified = path.join(".");
      if (declaredTables.has(qualified)) {
        // TOML 1.0 §6: table redefinition is a spec error. Lenient-
        // with-warn: surface the collision but keep traversing into
        // the same table so subsequent keys land in the existing
        // subtree. The duplicate's previous/new values coincide
        // because the target table object is shared.
        const existing = ensureTablePath(root, path, s.line);
        s.onDuplicateKey({
          key: qualified,
          previousValue: existing,
          newValue: existing,
          line: s.line,
        });
        currentTable = existing;
      } else {
        currentTable = ensureTablePath(root, path, s.line);
        declaredTables.add(qualified);
      }
      currentTablePath = path;
      continue;
    }

    // Key-value.
    const keyPath = parseKey(s);
    skipWhitespaceInline(s);
    if (peek(s) !== "=") {
      throw new TomlParseError(
        `expected '=' after key "${keyPath.join(".")}", got "${peek(s)}"`,
        s.line,
      );
    }
    advance(s);
    const value = parseValue(s);
    setNested(s, currentTable, keyPath, value, [
      ...currentTablePath,
      ...keyPath,
    ]);
    skipWhitespaceInline(s);
    if (peek(s) === "#") skipLine(s);
    else if (peek(s) === "\n") advance(s);
    else if (peek(s) === "") {
      // end of file
    } else if (peek(s) === "\r") {
      advance(s);
      if (peek(s) === "\n") advance(s);
    } else {
      throw new TomlParseError(
        `trailing content after value: "${peek(s)}"`,
        s.line,
      );
    }
  }

  return root;
}

// ─────────────────────────────────────────────────────────────────────
// loadConfig
// ─────────────────────────────────────────────────────────────────────

export interface LoadConfigOptions {
  readonly home?: string;
  /** Override onto the default config. Loader merges raw TOML on top. */
  readonly base?: AgenCConfig;
  /** Emit warnings for parse errors. Default writes to console.warn. */
  readonly onWarn?: (msg: string) => void;
}

export interface LoadedConfig {
  readonly config: AgenCConfig;
  readonly path: string;
  readonly exists: boolean;
  readonly parseError?: string;
}

/**
 * Read `<agenc_home>/config.toml` and merge onto `defaultConfig()`.
 *
 * - Missing file → returns defaults + `exists: false`.
 * - Parse/validation error → warns, returns defaults + `parseError` message.
 * - Unknown top-level keys → preserved under `config._unknown`.
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const home = opts.home ?? resolveAgencHome();
  const path = pathResolve(home, "config.toml");
  const base = opts.base ?? defaultConfig();
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));

  await runConfigFileMigrations({
    home,
    configTomlPath: path,
    onWarn,
    parseToml,
  });

  let raw: string;
  try {
    // I-81 + I-80: route through `readTextFile` so UTF-8 BOM is
    // stripped and line endings normalize to LF before the TOML
    // parser sees the bytes. Matches the raw-readFile ENOENT path
    // exactly — `readTextFile` re-throws the ErrnoException untouched.
    raw = await readTextFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return Object.freeze({
        config: base,
        path,
        exists: false,
      });
    }
    onWarn(`[agenc:config] failed to read ${path}: ${String(error)}`);
    return Object.freeze({
      config: base,
      path,
      exists: false,
      parseError: String(error),
    });
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(raw, {
      onDuplicateKey: (warning) => {
        onWarn(
          `[agenc:config] duplicate key "${warning.key}" at ${path}:` +
            `${warning.line} (last-write-wins)`,
        );
      },
    }) as Record<string, unknown>;
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);
    onWarn(`[agenc:config] invalid TOML at ${path}: ${msg}`);
    return Object.freeze({
      config: base,
      path,
      exists: true,
      parseError: msg,
    });
  }

  const aliased = normalizeAgenCKeyAliases(parsed);
  const migrated = migrateRawAgenCConfig(aliased);
  const normalized = normalizeRawConfig(migrated);
  let validated: AgenCConfig;
  try {
    validated = validateAgenCConfigBlocks(normalized);
  } catch (error) {
    const msg =
      error instanceof Error ? error.message : String(error);
    onWarn(`[agenc:config] invalid config at ${path}: ${msg}`);
    return Object.freeze({
      config: base,
      path,
      exists: true,
      parseError: msg,
    });
  }
  const merged = mergeConfigs(base, validated);
  return Object.freeze({
    config: merged,
    path,
    exists: true,
  });
}
