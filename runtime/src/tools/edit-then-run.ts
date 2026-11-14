import type { LLMToolCall } from "../llm/types.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { Tool } from "./types.js";

const EDITORS = new Set(["apply_patch", "Write", "Edit", "MultiEdit"]);

/**
 * Session-owned environment only. The AGENC_EDIT_THEN_RUN experiment is off by default.
 * The lean edit_mode "check" turns it on with a required check.
 */
export function editThenRunEnabled(lightMode: boolean | undefined,
  environment: Readonly<Record<string, string | undefined>> = {}, leanEditMode?: string): boolean {
  return lightMode === true && (environment.AGENC_EDIT_THEN_RUN === "1" || leanEditMode === "check");
}

/** edit_mode = "check": an option the model may leave out is rarely used, so the lean request requires it. */
export const REQUIRED_CHECK_DESCRIPTION =
  "Shell command that verifies this edit, usually the test command or a probe. It runs right after the edit and its output comes back with the edit.";

export function withEditThenRun(tool: Tool, required = false): Tool {
  if (!EDITORS.has(tool.name)) return tool;
  // Preserve getters and non-enumerable tool capabilities.
  return Object.defineProperties(Object.create(Object.getPrototypeOf(tool)), {
    ...Object.getOwnPropertyDescriptors(tool),
    inputSchema: { enumerable: true, configurable: true, value: {
      ...tool.inputSchema,
      properties: { ...(tool.inputSchema.properties as Record<string, unknown> | undefined),
        check: { type: "string", minLength: 1,
          description: required ? REQUIRED_CHECK_DESCRIPTION : "Shell command to run after a successful edit." },
      },
      ...(required ? { required: [...((tool.inputSchema.required as readonly string[] | undefined) ?? []), "check"] } : {}),
    } },
  });
}

/** The registered schema is the authority, including the session's switch. */
export function editThenRunCommand(call: LLMToolCall, registry: ToolRegistry): string | undefined {
  if (!EDITORS.has(call.name)) return undefined;
  const tool = registry.tools.find(candidate => candidate.name === call.name);
  if ((tool?.inputSchema.properties as Record<string, unknown> | undefined)?.check === undefined) return undefined;
  try {
    const input = JSON.parse(call.arguments) as Record<string, unknown>;
    return typeof input.check === "string" && input.check.length > 0 ? input.check : undefined;
  } catch { return undefined; }
}
