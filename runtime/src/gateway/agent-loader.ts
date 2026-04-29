/**
 * AgentDefinition loader (Cut 5.6).
 *
 * Loads markdown agent definition files from:
 *   1. `runtime/src/gateway/agent-definitions/*.md`  (built-in)
 *   2. `<projectRoot>/.agenc/agents/*.md`            (project-level)
 *   3. `~/.agenc/agents/*.md`                        (user-level)
 *
 * Each `.md` file has a YAML frontmatter block followed by a markdown
 * body. The frontmatter declares the agent's identity and capability
 * scope; the body becomes the system prompt for the spawned sub-agent.
 *
 * Replaces the bandit-arm + delegation-economics scoring with a
 * declarative configuration the runtime can introspect at startup.
 *
 * @module
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AgentDefinition {
  /** Stable identifier (kebab-case, used in tool calls). */
  readonly name: string;
  /** Single-line description shown to the model. */
  readonly description: string;
  /** Model alias the sub-agent should use. `inherit` reuses parent. */
  readonly model: "inherit" | string;
  /** Allowed tool names; empty array means "inherit from parent". */
  readonly tools: readonly string[];
  /** Hard turn budget for the sub-agent. */
  readonly maxTurns: number;
  /** Source label for diagnostics. */
  readonly source: "built-in" | "project" | "user";
  /** Absolute path of the loaded `.md` file. */
  readonly filePath: string;
  /** Markdown body — becomes the sub-agent's system prompt. */
  readonly body: string;
}

interface LoadAgentDefinitionsOptions {
  readonly projectRoot?: string;
  readonly homeDir?: string;
  readonly builtinDir?: string;
}

export function loadAgentDefinitions(
  options: LoadAgentDefinitionsOptions = {},
): readonly AgentDefinition[] {
  const seen = new Map<string, AgentDefinition>();
  const candidates: { dir: string; source: AgentDefinition["source"] }[] = [];

  if (options.builtinDir && existsSync(options.builtinDir)) {
    candidates.push({ dir: options.builtinDir, source: "built-in" });
  } else {
    // Default: look next to this module at runtime.
    const builtinFromCwd = path.join(
      process.cwd(),
      "runtime",
      "src",
      "gateway",
      "agent-definitions",
    );
    if (existsSync(builtinFromCwd)) {
      candidates.push({ dir: builtinFromCwd, source: "built-in" });
    }
  }

  if (options.projectRoot) {
    const projectDir = path.join(options.projectRoot, ".agenc", "agents");
    if (existsSync(projectDir)) {
      candidates.push({ dir: projectDir, source: "project" });
    }
  }

  const homeDir = options.homeDir ?? os.homedir();
  const userDir = path.join(homeDir, ".agenc", "agents");
  if (existsSync(userDir)) {
    candidates.push({ dir: userDir, source: "user" });
  }

  for (const { dir, source } of candidates) {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = path.join(dir, entry);
      try {
        const stat = statSync(full);
        if (!stat.isFile()) continue;
        const definition = parseAgentDefinition(full, source);
        if (definition) {
          // Later sources override earlier ones (user > project > built-in).
          seen.set(definition.name, definition);
        }
      } catch {
        // skip unreadable
      }
    }
  }

  return [...seen.values()];
}

function parseAgentDefinition(
  filePath: string,
  source: AgentDefinition["source"],
): AgentDefinition | null {
  const raw = readFileSync(filePath, "utf8");
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/.exec(raw);
  if (!match) return null;
  const frontmatter = parseFrontmatter(match[1] ?? "");
  const body = (match[2] ?? "").trim();
  const name =
    typeof frontmatter.name === "string" && frontmatter.name.trim().length > 0
      ? frontmatter.name.trim()
      : path.basename(filePath, ".md");
  const description =
    typeof frontmatter.description === "string"
      ? frontmatter.description.trim()
      : "";
  const model =
    typeof frontmatter.model === "string" && frontmatter.model.trim().length > 0
      ? frontmatter.model.trim()
      : "inherit";
  const tools = Array.isArray(frontmatter.tools)
    ? frontmatter.tools.filter((entry): entry is string => typeof entry === "string")
    : [];
  const maxTurns =
    typeof frontmatter.maxTurns === "number" && Number.isFinite(frontmatter.maxTurns)
      ? Math.max(1, Math.floor(frontmatter.maxTurns))
      : 5;
  return {
    name,
    description,
    model,
    tools,
    maxTurns,
    source,
    filePath,
    body,
  };
}

function parseFrontmatter(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, valueRaw = ""] = match;
    if (!key) continue;
    const trimmed = valueRaw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      // Inline list: [a, b, c]
      const inner = trimmed.slice(1, -1);
      result[key] = inner
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0)
        .map((entry) => stripQuotes(entry));
    } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
      result[key] = Number.parseFloat(trimmed);
    } else {
      result[key] = stripQuotes(trimmed);
    }
  }
  return result;
}

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
