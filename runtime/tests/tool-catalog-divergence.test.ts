/**
 * Task 15: the runtime carries two tool catalogs — the LIVE daemon
 * registry (`tool-registry.ts` + `bin/model-facing-tools.ts`) and the
 * TUI-side pool (`src/tools.ts` `getAllBaseTools()`, consumed by the
 * permission presets, AgentTool worker pool, and REPL primitives).
 * Full convergence is a TUI-architecture migration; until then this
 * test holds the line on the actual correctness risk: SILENT drift.
 *
 *   1. The set of names implemented in both catalogs is pinned. A new
 *      duplicate implementation cannot appear without editing the
 *      expectation below (a deliberate, reviewed act).
 *   2. For every dual-implemented tool, the required input parameters
 *      must agree between the two schemas — the drift class that turns
 *      a fix applied to one catalog into a silent miss in the other.
 */
import { mkdtempSync } from "node:fs";
import Module from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { getAllBaseTools } from "../src/tools.js";
import { buildToolRegistry } from "../src/tool-registry.js";

// getAllBaseTools lazy-requires SendMessageTool by its emitted .js path
// (a CJS cycle-breaker); under vitest only the .ts source exists, so the
// require can't resolve. Serve a stub through Node's module loader — the
// stub never overlaps a live registry name, so it can't mask divergence.
const originalLoad = (
  Module as unknown as { _load: (...args: unknown[]) => unknown }
)._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load =
  function (request: unknown, ...rest: unknown[]) {
    if (
      typeof request === "string" &&
      request.endsWith("SendMessageTool/SendMessageTool.js")
    ) {
      return {
        SendMessageTool: {
          name: "SendMessage",
          isEnabled: () => false,
          inputSchema: { shape: {} },
        },
      };
    }
    return originalLoad.call(this, request, ...rest);
  };

/**
 * Deliberate dual implementations (TUI pool + daemon registry). Each of
 * these exists twice on purpose while the TUI still assembles its own
 * pool. Adding a name here requires a reason; removing one means the
 * duplication was actually retired.
 */
const KNOWN_DUAL_IMPLEMENTATIONS = [
  "AskUserQuestion",
  "CronCreate",
  "CronDelete",
  "CronList",
  "Edit",
  "EnterPlanMode",
  "EnterWorktree",
  "ExitPlanMode",
  "ExitWorktree",
  "FileRead",
  "Glob",
  "Grep",
  "Monitor",
  "NotebookEdit",
  "TaskCreate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
  "TaskUpdate",
  "TodoWrite",
  "WebFetch",
  "WebSearch",
  "Write",
  "system.bash",
] as const;

function requiredKeys(schema: unknown): readonly string[] {
  if (typeof schema !== "object" || schema === null) return [];
  const required = (schema as { required?: unknown }).required;
  return Array.isArray(required)
    ? [...required].filter((k): k is string => typeof k === "string").sort()
    : [];
}

/**
 * The TUI pool's tools expose Zod schemas; where a JSON schema override
 * exists (`inputJSONSchema`) prefer it, else derive required keys from
 * the Zod object shape (non-optional top-level keys).
 */
function legacyRequiredKeys(tool: {
  inputJSONSchema?: unknown;
  inputSchema?: unknown;
}): readonly string[] | null {
  if (tool.inputJSONSchema !== undefined) {
    return requiredKeys(tool.inputJSONSchema);
  }
  const schema = tool.inputSchema as
    | { shape?: Record<string, { isOptional?: () => boolean }> }
    | undefined;
  const shape = schema?.shape;
  if (shape === undefined || typeof shape !== "object") return null;
  return Object.entries(shape)
    .filter(([, value]) => {
      try {
        return typeof value?.isOptional === "function"
          ? !value.isOptional()
          : true;
      } catch {
        return true;
      }
    })
    .map(([key]) => key)
    .sort();
}

describe("tool catalog divergence guard", () => {
  const registry = buildToolRegistry({
    workspaceRoot: mkdtempSync(join(tmpdir(), "agenc-catalog-")),
  });
  const liveByName = new Map(registry.tools.map((tool) => [tool.name, tool]));
  const legacyByName = new Map(
    getAllBaseTools().map((tool) => [tool.name, tool]),
  );

  it("pins the set of dual-implemented tool names", () => {
    // Subset (allowlist) semantics: several dual tools are feature/env
    // gated (Monitor, worktree tools, Glob/Grep vs embedded search), so
    // the overlap varies per environment — but every member must be a
    // KNOWN exception. A new duplicate implementation fails here.
    const overlap = [...liveByName.keys()]
      .filter((name) => legacyByName.has(name))
      .sort();
    const known = new Set<string>(KNOWN_DUAL_IMPLEMENTATIONS);
    expect(overlap.filter((name) => !known.has(name))).toEqual([]);
    // The core always-on duals must actually be present — guards the
    // test itself against silently comparing empty sets.
    for (const expected of ["Edit", "Write", "FileRead", "TodoWrite"]) {
      expect(overlap).toContain(expected);
    }
  });

  it("dual-implemented tools agree on required input parameters", () => {
    const disagreements: string[] = [];
    for (const name of KNOWN_DUAL_IMPLEMENTATIONS) {
      const live = liveByName.get(name);
      const legacy = legacyByName.get(name);
      if (live === undefined || legacy === undefined) continue;
      const liveRequired = requiredKeys(live.inputSchema);
      const legacyRequired = legacyRequiredKeys(
        legacy as { inputJSONSchema?: unknown; inputSchema?: unknown },
      );
      if (legacyRequired === null) continue; // schema shape not introspectable
      if (JSON.stringify(liveRequired) !== JSON.stringify(legacyRequired)) {
        disagreements.push(
          `${name}: live requires [${liveRequired.join(", ")}], TUI pool requires [${legacyRequired.join(", ")}]`,
        );
      }
    }
    expect(disagreements).toEqual([]);
  });

  it("the hard-nulled graveyard stays deleted from the TUI pool", () => {
    for (const retired of [
      // The env-gated legacy LSPTool duplicate was deleted; the daemon
      // registry's `LSP` tool is the only implementation.
      "LSP",
      "Sleep",
      "RemoteTrigger",
      "SendUserFile",
      "PushNotification",
      "SubscribePR",
      "TerminalCapture",
      "WebBrowser",
      "Snip",
      "ListPeers",
      "Workflow",
    ]) {
      expect(legacyByName.has(retired)).toBe(false);
    }
  });
});
