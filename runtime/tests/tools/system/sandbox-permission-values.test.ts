/**
 * sandbox_permissions values outside the three modes.
 *
 * lt30-1931-mpv-C-r1 (2026-11-06, DeepSeek Light on 0.19.30): the model filled
 * in every exec_command field and sent `"sandbox_permissions":"use_default"`.
 * Each call was refused with a message about objects, the model repeated the
 * same calls, the repeat guard refused them and the no-progress backstop ended
 * a long task. A value that can only mean the default sandbox is now read as
 * "default" at the model-input entry point, before any hook, rule or approval;
 * nothing is ever read as an escalation, and any other value gets a message
 * that names it and the accepted values.
 */
import { describe, expect, test } from "vitest";

import {
  normalizeModelToolArgs,
  validateToolArgs,
} from "../../../src/tools/argument-validation.js";
import { prepareModelToolArgs, validateToolPreflight } from "../../../src/tools/execution.js";
import { getSchemaValidationErrorOverride } from "../../../src/tools/schema-errors.js";
import { createExecCommandTool } from "../../../src/tools/system/exec-command.js";
import { createWriteStdinTool } from "../../../src/tools/system/write-stdin.js";
import {
  SANDBOX_PERMISSION_VALUES,
  foldDefaultSandboxPermission,
  isDefaultSandboxPermissionAlias,
} from "../../../src/tools/system/sandbox-permission-values.js";
import {
  parseSandboxPermissionsArgs,
  sandboxPermissionsFromArgs,
} from "../../../src/sandbox/escalation/sandboxing.js";
import { EventLog } from "../../../src/session/event-log.js";

/** The two calls lt30-1931-mpv-C-r1 repeated until the turn stopped (request 13 on). */
const C_R1_GREP = {
  cmd: 'grep -n "taillight\\|ledMaterial\\|sideLEDMaterial\\|highBrake\\|sunroofBase\\|rearCap\\|scene.add" src/car.js | head -80',
  justification: "",
  login: false,
  max_output_tokens: 12000,
  prefix_rule: [],
  sandbox_permissions: "use_default",
  shell: "bash",
  tty: false,
  workdir: "/workspace",
  yield_time_ms: 10000,
};
const C_R1_CHECK = {
  ...C_R1_GREP,
  cmd: "node --check src/car.js; node --check src/main.js; node --check src/studio.js; node --check src/materials.js; node --check server.js",
};

const DEFAULT_SPELLINGS: readonly unknown[] = [
  "use_default", "USE_DEFAULT", "use-default", " use default ", "none", "None", "", "   ",
  null, "Default", " default",
];

/** Values a model might mean as an escalation, or anything else that is not a default spelling. */
const NOT_DEFAULT: readonly unknown[] = [
  "require_escalated", "with_additional_permissions", "escalated", "elevated", "full",
  "full_access", "danger-full-access", "unrestricted", "no_sandbox", "bypass", "network",
  "true", "yes", "on", "sandbox", "use_escalated", "require escalated", "defaults",
  "use_defaults", "nonee", { network: "full" }, ["require_escalated"], ["default"], true,
  false, 0, 1,
];

function execTool() {
  return createExecCommandTool({ cwd: "/workspace", allowedPaths: ["/workspace"] });
}

function warningsOf(eventLog: EventLog): unknown[] {
  const warnings: unknown[] = [];
  eventLog.subscribe((event) => {
    if (event.msg.type === "warning") warnings.push(event.msg.payload);
  });
  return warnings;
}

describe("the recorded lt30 C-r1 calls", () => {
  test("fail strict validation, so 0.19.30 refused them", () => {
    const exec = execTool();
    for (const call of [C_R1_GREP, C_R1_CHECK]) {
      expect(validateToolArgs(exec.inputSchema, call).valid).toBe(false);
    }
  });

  test("run with sandbox_permissions \"default\" through the model-input entry point", () => {
    const exec = execTool();
    for (const call of [C_R1_GREP, C_R1_CHECK]) {
      const before = JSON.stringify(call);
      expect(normalizeModelToolArgs(exec.inputSchema, call, exec.reshapeModelArgs)).toEqual({
        valid: true,
        errors: [],
        args: { ...call, sandbox_permissions: "default" },
        reshaped: true,
      });
      expect(JSON.stringify(call)).toBe(before);

      const args: Record<string, unknown> = structuredClone(call);
      const eventLog = new EventLog();
      const warnings = warningsOf(eventLog);
      prepareModelToolArgs(exec, args, eventLog);
      expect(args).toEqual({ ...call, sandbox_permissions: "default" });
      expect(validateToolPreflight(exec, args)).toBe(null);
      expect(warnings).toContainEqual({
        cause: "tool_input_reshaped",
        message: JSON.stringify({ tool: "exec_command", from: Object.keys(call), to: Object.keys(call) }),
      });
      // The approval layer and the sandbox see no escalation request.
      expect(parseSandboxPermissionsArgs(args)).toEqual({ kind: "ok", request: { kind: "default" } });
      expect(sandboxPermissionsFromArgs(args)).toEqual({ kind: "default" });
    }
  });

  test("with an unknown value instead, are refused with the value and the accepted values named", () => {
    const exec = execTool();
    const args: Record<string, unknown> = { ...C_R1_GREP, sandbox_permissions: "full" };
    prepareModelToolArgs(exec, args);
    expect(args.sandbox_permissions).toBe("full");
    const refusal = validateToolPreflight(exec, args);
    const expected = getSchemaValidationErrorOverride(exec, args);
    expect(expected).toContain('not "full"');
    expect(expected).toContain('"default", "require_escalated" or "with_additional_permissions"');
    expect(refusal?.content).toBe(`<tool_use_error>InputValidationError: ${expected}</tool_use_error>`);
  });
});

describe("foldDefaultSandboxPermission", () => {
  test.each(DEFAULT_SPELLINGS)("reads %j as \"default\"", (value) => {
    const args = { cmd: "ls", workdir: "/workspace", sandbox_permissions: value };
    const before = JSON.stringify(args);
    expect(isDefaultSandboxPermissionAlias(value)).toBe(true);
    const folded = foldDefaultSandboxPermission(args);
    expect(folded).toEqual({ cmd: "ls", workdir: "/workspace", sandbox_permissions: "default" });
    expect(folded).not.toBe(args);
    expect(JSON.stringify(args)).toBe(before);
  });

  test.each(NOT_DEFAULT)("declines %j", (value) => {
    expect(isDefaultSandboxPermissionAlias(value)).toBe(false);
    expect(foldDefaultSandboxPermission({ cmd: "ls", sandbox_permissions: value })).toBeUndefined();
  });

  test("declines a call without the field and the value \"default\" itself", () => {
    expect(foldDefaultSandboxPermission({ cmd: "ls" })).toBeUndefined();
    expect(foldDefaultSandboxPermission({ cmd: "ls", sandbox_permissions: "default" })).toBeUndefined();
  });

  test("never produces an escalated mode", () => {
    for (const value of [...DEFAULT_SPELLINGS, ...NOT_DEFAULT, ...SANDBOX_PERMISSION_VALUES]) {
      const folded = foldDefaultSandboxPermission({ cmd: "ls", sandbox_permissions: value });
      expect(folded === undefined || folded.sandbox_permissions === "default").toBe(true);
    }
  });

  test("an escalation request stays exactly as sent", () => {
    const exec = execTool();
    const args: Record<string, unknown> = {
      cmd: "npm install",
      sandbox_permissions: "require_escalated",
      justification: "Install dependencies?",
    };
    prepareModelToolArgs(exec, args);
    expect(args).toEqual({
      cmd: "npm install",
      sandbox_permissions: "require_escalated",
      justification: "Install dependencies?",
    });
  });

  test("a default spelling next to another error keeps the original errors", () => {
    const exec = execTool();
    const input = { cmd: "ls", sandbox_permissions: "use_default", colour: "red" };
    const result = normalizeModelToolArgs(exec.inputSchema, input, exec.reshapeModelArgs);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(validateToolArgs(exec.inputSchema, input).errors);
    // The override stays quiet, so the generic prose names the unexpected key.
    expect(validateToolPreflight(exec, input)?.content).toContain(
      "An unexpected parameter `colour` was provided",
    );
  });

  test("write_stdin carries the same fold", () => {
    const writeStdin = createWriteStdinTool({ cwd: "/workspace" });
    expect(writeStdin.reshapeModelArgs).toBe(foldDefaultSandboxPermission);
    const args: Record<string, unknown> = { session_id: 3, chars: "", sandbox_permissions: "use_default" };
    expect(validateToolArgs(writeStdin.inputSchema, args).valid).toBe(false);
    prepareModelToolArgs(writeStdin, args);
    expect(args).toEqual({ session_id: 3, chars: "", sandbox_permissions: "default" });
    expect(validateToolPreflight(writeStdin, args)).toBe(null);
  });
});
