import React from "react";
import { describe, expect, it, vi } from "vitest";
import { classifyApprovalRisk, typedConfirmationWordForRisk } from "../../src/permissions/risk.js";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import { AgenCPermissionOverlay, type PendingRequest } from "../../src/tui/permission-requests.js";
import { renderToString } from "../../src/utils/staticRender.js";

const bindings = vi.hoisted(() => ({ handlers: {} as Record<string, () => unknown> }));

vi.mock("../../src/tui/ink.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/tui/ink.js")>(),
  useInput: () => {},
}));
vi.mock("../../src/tui/keybindings/useKeybinding.js", () => ({
  useKeybindings: (handlers: Record<string, () => unknown>) => { bindings.handlers = handlers; },
}));

describe("cron approval operation classification", () => {
  it.each([
    "Run the tests. Do not create, list, or delete cron jobs.",
    "Review documentation containing rm -rf without executing it.",
    "Report whether the transfer and stake examples are documented.",
  ])("treats the CronCreate prompt as scheduled data: %s", (prompt) => {
    const toolInput = { cron: "* * * * *", prompt, recurring: false, durable: false };
    const risk = classifyApprovalRisk({
      request: { ctx: { toolName: "CronCreate" } },
      description: "Permission required to use CronCreate",
      command: JSON.stringify(toolInput),
      toolInput,
    });
    expect(risk).toBe("low");
    expect(typedConfirmationWordForRisk({ risk, toolName: "CronCreate", toolInput })).toBe("yes");
  });

  it("requires deletion confirmation for the actual CronDelete operation", () => {
    const toolInput = { id: "scheduled-job" };
    const risk = classifyApprovalRisk({ request: { ctx: { toolName: "CronDelete" } }, toolInput });
    expect(risk).toBe("destructive");
    expect(classifyApprovalRisk({ toolName: "CronDelete" })).toBe("destructive");
    expect(typedConfirmationWordForRisk({ risk, toolName: "CronDelete", toolInput })).toBe("delete");
  });

  it.each([
    ["CronCreate", { prompt: "Report only", action: "delete" }],
    ["CronCreate", { prompt: "Report only", command: "rm -rf /tmp/fixture" }],
    ["mcp.scheduler.CronCreate", { prompt: "delete records" }],
    ["unknown_scheduler", { query: "DELETE FROM jobs" }],
    ["exec_command", { cmd: "rm -rf /tmp/fixture" }],
    ["write_stdin", { session_id: 1, chars: "rm -rf /tmp/fixture\n" }],
  ])("preserves destructive action checks for %s", (toolName, toolInput) => {
    expect(classifyApprovalRisk({ toolName, toolInput })).toBe("destructive");
  });

  it.each(["CronCreate", "CronDelete"])("renders operation-appropriate confirmation for %s", async (toolName) => {
    const resolve = vi.fn();
    const input = toolName === "CronCreate"
      ? { cron: "* * * * *", prompt: "Run tests. Do not delete cron jobs.", recurring: false }
      : { id: "scheduled-job" };
    const request: PendingRequest = {
      id: "cron-approval",
      ctx: { callId: "cron-approval", toolName, turnId: "turn-1" } as ApprovalCtx,
      input,
      description: `Permission required to use ${toolName}`,
      resolve,
    };
    const rendered = await renderToString(
      <AgenCPermissionOverlay request={request} tools={[{ name: toolName }]} />,
      { columns: 120, rows: 40 },
    );
    if (toolName === "CronCreate") {
      expect(rendered).not.toContain("DESTRUCTIVE");
      bindings.handlers["confirm:yes"]?.();
      expect(resolve).toHaveBeenCalledWith({ kind: "approved" });
    } else {
      expect(rendered).toContain("DESTRUCTIVE");
      expect(bindings.handlers["confirm:yes"]?.()).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
    }
  });
});
