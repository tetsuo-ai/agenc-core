import { describe, expect, test, vi } from "vitest";

import type { ApprovalCtx } from "../tools/orchestrator.js";
import { APPROVED } from "../permissions/review-decision.js";
import {
  buildToolUseConfirmQueue,
  collectPermissionToolNames,
  type PendingRequest,
} from "./permission-requests.js";
import { createTuiTools } from "./tool-rendering.js";

describe("queued child tool approvals", () => {
  test("keeps unobserved child tools pending behind a parent approval", () => {
    const inputs: Array<[string, string, Record<string, unknown>]> = [
      ["parent-spawn", "spawn_agent", { task_name: "backend" }],
      ["child-shell", "exec_command", { cmd: "node --test", workdir: "/project" }],
      ["child-tool", "mcp__review__inspect", { path: "/project/server.js" }],
    ];
    const requests: PendingRequest[] = inputs.map(([id, toolName, input]) => ({
      id,
      ctx: { callId: id, toolName, turnId: "turn-1" } as ApprovalCtx,
      input,
      description: `Permission required to use ${toolName}`,
      resolve: vi.fn(),
    }));
    const observed = new Set(["spawn_agent"]);
    const tools = createTuiTools(collectPermissionToolNames(observed, requests));
    const queue = buildToolUseConfirmQueue(requests, tools) as Array<{
      tool: { name: string };
      onAllow(input: unknown): void;
    }>;

    expect(queue.map((item) => item.tool.name)).toEqual([
      "spawn_agent", "exec_command", "mcp__review__inspect",
    ]);
    for (const request of requests) expect(request.resolve).not.toHaveBeenCalled();
    expect([...observed]).toEqual(["spawn_agent"]);

    queue[1]!.onAllow(requests[1]!.input);
    expect(requests[1]!.resolve).toHaveBeenCalledExactlyOnceWith(APPROVED);
    expect(requests[0]!.resolve).not.toHaveBeenCalled();
    expect(requests[2]!.resolve).not.toHaveBeenCalled();
  });
});
