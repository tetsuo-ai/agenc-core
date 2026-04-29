import { describe, expect, test } from "vitest";

import { renderToolPresentation, toolRendererTone } from "./tool-renderers.js";

describe("tool renderers", () => {
  test("renders model-facing agent and task tools with specific labels", () => {
    expect(
      renderToolPresentation({
        toolName: "spawn_agent",
        toolArgs: {
          task_name: "task_1",
          agent_type: "runner",
          message: "go inspect the parser",
          model: "qwen3",
          reasoning_effort: "medium",
        },
        result: JSON.stringify({
          task_name: "/root/task_1",
          nickname: "BridgeRunner",
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "agent",
      title: "Spawned BridgeRunner [Runner] (qwen3 medium)",
      target: "",
      detail: "go inspect the parser",
    });

    expect(
      renderToolPresentation({
        toolName: "close_agent",
        toolArgs: { target: "/root/task_1" },
        result: JSON.stringify({
          previous_status: { status: "running", turnId: "t", startedAtMs: 1 },
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "agent",
      title: "Closed /root/task_1",
      target: "",
    });

    expect(
      renderToolPresentation({
        toolName: "wait_agent",
        toolArgs: {},
        result: JSON.stringify({
          message: "Wait completed.",
          timed_out: false,
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "agent",
      title: "Finished waiting",
      target: "",
      detail: "Wait completed.",
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

    expect(
      renderToolPresentation({
        toolName: "TaskCreate",
        toolArgs: { subject: "Create renderer" },
        result: JSON.stringify({
          task: {
            id: "2",
            subject: "Create renderer",
            status: "pending",
            owner: "scanner",
          },
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "task",
      title: "Task Create",
      target: "Create renderer",
      detail: "#2 Create renderer (pending) (@Scanner)",
      preserveResultLines: true,
    });

    expect(
      renderToolPresentation({
        toolName: "list_agents",
        toolArgs: { path_prefix: "/root" },
        result: JSON.stringify({
          agents: [
            {
              agent_name: "/root",
              agent_status: "pending_init",
              last_task_message: "Main thread",
            },
            {
              agent_name: "/root/scout",
              agent_status: { completed: "renderer path mapped" },
              last_task_message: "inspect renderer",
            },
          ],
        }),
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "agent",
      title: "Agents",
      target: "/root",
      detail:
        "/root: pending_init - Main thread\n/root/scout: completed: renderer path mapped - inspect renderer",
      preserveResultLines: true,
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
    expect(toolRendererTone("ListDir")).toBe("list");
    expect(toolRendererTone("Grep")).toBe("search");
    expect(toolRendererTone("WebFetch")).toBe("web");
    expect(toolRendererTone("mcp.github.listIssues")).toBe("mcp");
  });

  test("renders plan file writes as plan updates", () => {
    const planPath = `${process.env.HOME ?? "/home/u"}/.agenc/plans/demo.md`;
    expect(
      renderToolPresentation({
        toolName: "Write",
        toolArgs: { path: planPath },
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "write",
      title: "Updated Plan",
      target: "",
    });
  });

  test("renders interactive plan tools without raw argument chrome", () => {
    expect(
      renderToolPresentation({
        toolName: "AskUserQuestion",
        toolArgs: {
          questions: [
            {
              header: "M5 scope",
              question: "Prioritize M5 sub-tasks?",
              options: [{ label: "Full plan" }, { label: "Compounds" }],
            },
          ],
        },
        result:
          'User has answered your questions: Prioritize M5 sub-tasks? -> Full plan as-is. You can now continue with the user\'s answers in mind.',
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "plan",
      title: "User Answered",
      target: "",
      detail: "Prioritize M5 sub-tasks? -> Full plan as-is",
    });

    expect(
      renderToolPresentation({
        toolName: "ExitPlanMode",
        toolArgs: { plan: "raw plan argument should not render" },
        result:
          "User has approved your plan. You can now start coding.\n\n## Approved Plan:\nImplement M5.",
        isComplete: true,
        isError: false,
      }),
    ).toMatchObject({
      tone: "plan",
      title: "Plan Approved",
      target: "",
      detail: "Implement M5.",
      preserveResultLines: true,
    });
  });
});
