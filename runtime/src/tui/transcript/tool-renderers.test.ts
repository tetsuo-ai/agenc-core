import { describe, expect, test } from "vitest";

import { renderToolPresentation, toolRendererTone } from "./tool-renderers.js";

describe("tool renderers", () => {
  test("renders model-facing agent and task tools with specific labels", () => {
    expect(
      renderToolPresentation({
        toolName: "Agent",
        toolArgs: { task: "inspect renderer" },
        isComplete: false,
        isError: false,
      }),
    ).toMatchObject({
      tone: "agent",
      title: "Agent Running",
      target: "inspect renderer",
    });

    expect(
      renderToolPresentation({
        toolName: "TaskList",
        toolArgs: {},
        result: JSON.stringify({
          tasks: [{ id: "1", subject: "Renderer parity", status: "pending" }],
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "task",
      title: "Task List",
      detail: "#1 Renderer parity (pending)",
    });
  });

  test("renders MCP resource results compactly", () => {
    expect(
      renderToolPresentation({
        toolName: "ListMcpResourcesTool",
        toolArgs: { server: "docs" },
        result: JSON.stringify({
          resources: [{ server: "docs", uri: "file://readme" }],
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "mcp",
      title: "MCP Resources",
      target: "docs",
      detail: "docs · file://readme",
    });
  });

  test("classifies tool tones for grouping", () => {
    expect(toolRendererTone("FileRead")).toBe("read");
    expect(toolRendererTone("Grep")).toBe("search");
    expect(toolRendererTone("WebFetch")).toBe("web");
    expect(toolRendererTone("mcp.github.listIssues")).toBe("mcp");
  });
});
