import React from "react";
import { describe, expect, it, vi } from "vitest";
import type { ApprovalCtx } from "../../src/tools/orchestrator.js";
import type { ReviewDecision } from "../../src/permissions/review-decision.js";
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

describe("typed confirmation shortcut ownership", () => {
  it("does not interpret the n in transfer as a denial shortcut", async () => {
    const decisions: ReviewDecision[] = [];
    const input = { command: "agenc transfer --mainnet --amount 5" };
    const request: PendingRequest = {
      id: "transfer-confirmation",
      ctx: { callId: "transfer-confirmation", toolName: "Bash", turnId: "turn-1" } as ApprovalCtx,
      input,
      description: "Confirm transfer",
      resolve: decision => decisions.push(decision),
    };
    const output = await renderToString(<AgenCPermissionOverlay request={request} tools={[{ name: "Bash" }]} />, { rows: 40, columns: 120 });
    expect(output).toContain("transfer");
    expect(bindings.handlers["confirm:no"]?.()).toBe(false);
    expect(bindings.handlers["confirm:yes"]?.()).toBe(false);
    expect(decisions).toEqual([]);
    bindings.handlers["app:interrupt"]?.();
    expect(decisions).toEqual([{ kind: "abort" }]);
  });
});
