// Shared deterministic checks for the Asteroid Drift session task. No network,
// no timing: every check reads the workspace (cwd) and exits nonzero on failure.
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, extname, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", ".git", ".agenc", "coverage"]);

export function jsFiles(root = process.cwd()) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (extname(entry.name) === ".js" || extname(entry.name) === ".mjs") {
        out.push(join(dir, entry.name));
      }
    }
  };
  walk(root);
  return out.sort((a, b) => a.localeCompare(b));
}

export function read(path) {
  return readFileSync(path, "utf8");
}

export function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

export function ok(message) {
  process.stdout.write(`${message}\n`);
}

export function requireFiles(paths) {
  const missing = paths.filter((p) => !existsSync(p) || !statSync(p).isFile());
  if (missing.length > 0) fail(`missing files: ${missing.join(", ")}`);
}

/** Any of the patterns must match somewhere in the workspace's JS or HTML. */
export function requireAny(patterns, label) {
  const sources = [...jsFiles(), ...htmlFiles()].map((p) => read(p)).join("\n");
  if (!patterns.some((pattern) => pattern.test(sources))) {
    fail(`${label}: none of ${patterns.map(String).join(" | ")} found`);
  }
}

export function htmlFiles(root = process.cwd()) {
  return readdirSync(root)
    .filter((name) => name.endsWith(".html"))
    .map((name) => join(root, name));
}

/**
 * The style rules the user states in prompt 1 and that every later prompt must
 * preserve: two-space indentation and no semicolon-terminated statements, in
 * every JavaScript file of the project (tests included).
 */
export function checkStyle() {
  const problems = [];
  for (const file of jsFiles()) {
    const rel = relative(process.cwd(), file);
    const lines = read(file).split("\n");
    let inBlockComment = false;
    lines.forEach((line, index) => {
      const trimmed = line.trim();
      if (inBlockComment) {
        if (trimmed.includes("*/")) inBlockComment = false;
        return;
      }
      if (trimmed.startsWith("/*")) {
        if (!trimmed.includes("*/")) inBlockComment = true;
        return;
      }
      if (trimmed.startsWith("//") || trimmed.length === 0) return;
      if (line.startsWith("\t")) problems.push(`${rel}:${index + 1} tab indentation`);
      const indent = line.match(/^ */)[0].length;
      if (indent % 2 !== 0) problems.push(`${rel}:${index + 1} indentation of ${indent} is not a multiple of 2`);
      if (/;\s*(\/\/.*)?$/.test(line) && !/^\s*for\s*\(/.test(line)) {
        problems.push(`${rel}:${index + 1} semicolon-terminated line`);
      }
    });
  }
  return problems;
}

export function runNodeTests() {
  // Force the TAP reporter: Node prints the spec reporter even when piped, and
  // the verifiers parse the "# pass N" summary line.
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap"], {
    cwd: process.cwd(),
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, NODE_OPTIONS: "" },
  });
  return result;
}
