import React from "react";
import { describe, expect, it, vi } from "vitest";
import { AssistantToolUseMessage } from "../../src/tui/message-renderers/AssistantToolUseMessage.js";
import { AppStateProvider, getDefaultAppState } from "../../src/tui/state/AppState.js";
import { renderToString } from "../../src/utils/staticRender.js";
import type { Tool } from "../../src/tools/Tool.js";
import { buildMessageLookups } from "../../src/utils/messages.js";

vi.mock("../../src/utils/classifierApprovalsHook.js", () => ({ useIsClassifierChecking: () => false }));

describe("retry status follows canonical completion", () => {
  it.each(["queued", "running", "done", "failed"])("renders %s without inventing success", async status => {
    const param = { type: "tool_use" as const, id: "retry-last", name: "exec_command", input: { cmd: "node --test" }, retriedFailureCount: 2 };
    const tool = {
      name: "exec_command", inputSchema: { safeParse: (input: unknown) => ({ success: true, data: input }) },
      userFacingName: () => "Run", renderToolUseMessage: () => "node --test",
      renderToolUseProgressMessage: () => null,
    } as unknown as Tool;
    const completed = status === "done" || status === "failed";
    const output = await renderToString(<AppStateProvider initialState={getDefaultAppState()}>
      <AssistantToolUseMessage param={param} addMargin={false} tools={[tool]} commands={[]} verbose={false}
        inProgressToolUseIDs={new Set(status === "running" ? [param.id] : [])} progressMessagesForMessage={[]}
        shouldAnimate={false} shouldShowDot={false}
        lookups={{ ...buildMessageLookups([], []), resolvedToolUseIDs: new Set(completed ? [param.id] : []), erroredToolUseIDs: new Set(status === "failed" ? [param.id] : []) }} />
    </AppStateProvider>, 100);
    expect(output).not.toContain("ERROR");
    expect(output).not.toContain("TypeError");
    if (status === "done") expect(output).toContain("succeeded after 2 attempts");
    else expect(output).not.toContain("succeeded");
    if (status === "queued" || status === "running") expect(output).toContain(`attempt 2 · ${status}`);
  });
});
