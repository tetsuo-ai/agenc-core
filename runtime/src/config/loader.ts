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
// This is enough for AgenC's config surface (codex + openclaude fields).
// Unknown TOML values are still parsed and surfaced to the caller via
// `normalizeRawConfig` (→ `_unknown` side-table).

import { readFile } from "node:fs/promises";
import { resolve as pathResolve } from "node:path";
import type { AgenCConfig } from "./schema.js";
import {
  defaultConfig,
  mergeConfigs,
  normalizeRawConfig,
} from "./schema.js";
import { resolveAgencHome } from "./env.js";

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

interface ParseState {
  src: string;
  pos: number;
  line: number;
}

function newState(src: string): ParseState {
  return { src, pos: 0, line: 1 };
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

function parseKey(s: ParseState): string[] {
  // Dotted keys → returns path segments.
  const parts: string[] = [];
  while (true) {
    skipWhitespaceInline(s);
    const segment = parseKeySegment(s);
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
    setNested(out, keyPath, value, s.line);
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

function setNested(
  root: Record<string, TomlValue>,
  path: string[],
  value: TomlValue,
  line: number,
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
        line,
      );
    }
  }
  cur[path[path.length - 1]!] = value;
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

export function parseToml(src: string): Record<string, TomlValue> {
  const root: Record<string, TomlValue> = {};
  const s = newState(src);
  let currentTable = root;

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
      currentTable = ensureTablePath(root, path, s.line);
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
    setNested(currentTable, keyPath, value, s.line);
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
 * - Parse error → warns, returns defaults + `parseError` message.
 * - Unknown top-level keys → preserved under `config._unknown`.
 */
export async function loadConfig(
  opts: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const home = opts.home ?? resolveAgencHome();
  const path = pathResolve(home, "config.toml");
  const base = opts.base ?? defaultConfig();
  const onWarn = opts.onWarn ?? ((m: string) => console.warn(m));

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
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
    parsed = parseToml(raw) as Record<string, unknown>;
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

  const normalized = normalizeRawConfig(parsed);
  const merged = mergeConfigs(base, normalized);
  return Object.freeze({
    config: merged,
    path,
    exists: true,
  });
}
