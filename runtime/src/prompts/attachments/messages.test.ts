/**
 * Tests for the attachment-to-LLMMessage renderer. Covers every
 * Attachment kind currently shipped — when a new kind is added to
 * `./types.ts`, add a render case here.
 */
import { describe, expect, test } from "vitest";

import { attachmentsToMessages } from "./messages.js";
import type { Attachment } from "./types.js";

describe("attachmentsToMessages", () => {
  test("returns an empty array when no attachments are passed", () => {
    expect(attachmentsToMessages([])).toEqual([]);
  });

  test("renders a nested_memory attachment as a user-context message", () => {
    const attachments: Attachment[] = [
      {
        kind: "nested_memory",
        path: "/repo/AGENC.md",
        displayPath: "AGENC.md",
        memoryType: "Project",
        content: "Project rules go here.",
        mtimeMs: 1_700_000_000_000,
      },
    ];
    const out = attachmentsToMessages(attachments);
    expect(out).toHaveLength(1);
    expect(out[0]?.role).toBe("user");
    expect(typeof out[0]?.content).toBe("string");
    expect(out[0]?.content).toContain("## Memory: AGENC.md (Project)");
    expect(out[0]?.content).toContain("Project rules go here.");
    expect(out[0]?.runtimeOnly?.mergeBoundary).toBe("user_context");
  });

  test("skips a relevant_memories attachment with no memories", () => {
    const out = attachmentsToMessages([
      { kind: "relevant_memories", memories: [] },
    ]);
    expect(out).toEqual([]);
  });

  test("renders relevant_memories with stable headers and truncation note", () => {
    const out = attachmentsToMessages([
      {
        kind: "relevant_memories",
        memories: [
          {
            path: "~/.agenc/memory/topic.md",
            content: "memory body",
            mtimeMs: 1_700_000_000_000,
            header: "## ~/.agenc/memory/topic.md (mtime: yesterday)",
            limit: 200,
          },
        ],
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toContain(
      "## ~/.agenc/memory/topic.md (mtime: yesterday)",
    );
    expect(out[0]?.content).toContain("memory body");
    expect(out[0]?.content).toContain(
      "This memory file was truncated at 200 lines.",
    );
    expect(out[0]?.content).toContain("<system-reminder>");
  });

  test("renders both plan_mode variants with the AGENC plan-file path", () => {
    const planFilePath = "/home/u/.agenc/plans/active.md";
    const full = attachmentsToMessages([
      { kind: "plan_mode", variant: "full", planFilePath, planExists: false },
    ]);
    const sparse = attachmentsToMessages([
      { kind: "plan_mode", variant: "sparse", planFilePath, planExists: true },
    ]);
    expect(full[0]?.content).toContain("Plan mode is active");
    expect(full[0]?.content).toContain(planFilePath);
    expect(full[0]?.content).toContain("Write tool");
    expect(full[0]?.content).toContain("## Plan Workflow");
    expect(full[0]?.content).toContain("### Phase 5: Call ExitPlanMode");
    expect(sparse[0]?.content).toContain("Plan mode is active");
    expect(sparse[0]?.content).toContain(planFilePath);
    expect(sparse[0]?.content).toContain("Plan mode still active");
    expect(sparse[0]?.content).toContain("Read-only except plan file");
  });

  test("renders plan_mode_reentry and plan_mode_exit with appropriate prose", () => {
    const planFilePath = "/home/u/.agenc/plans/x.md";
    const reentry = attachmentsToMessages([
      { kind: "plan_mode_reentry", planFilePath, planExists: true },
    ]);
    const exit = attachmentsToMessages([
      { kind: "plan_mode_exit", planFilePath, planExists: true },
    ]);
    expect(reentry[0]?.content).toContain("Re-entering plan mode");
    expect(reentry[0]?.content).toContain("Treat this as a fresh planning session");
    expect(exit[0]?.content).toContain("Exited plan mode");
    expect(exit[0]?.content).toContain(planFilePath);
  });

  test("renders auto_mode and auto_mode_exit", () => {
    const full = attachmentsToMessages([
      { kind: "auto_mode", variant: "full" },
    ]);
    const sparse = attachmentsToMessages([
      { kind: "auto_mode", variant: "sparse" },
    ]);
    const exit = attachmentsToMessages([{ kind: "auto_mode_exit" }]);
    expect(full[0]?.content).toContain("Auto mode is active");
    expect(full[0]?.content).toContain("Auto Mode Active");
    expect(full[0]?.content).toContain("Avoid data exfiltration");
    expect(sparse[0]?.content).toContain("Auto mode is active");
    expect(sparse[0]?.content).toContain("Auto mode still active");
    expect(exit[0]?.content).toContain("exited auto mode");
    expect(exit[0]?.content).toContain("clarifying questions");
  });

  test("renders date_change with the new date", () => {
    const out = attachmentsToMessages([
      { kind: "date_change", newDate: "2026-04-26" },
    ]);
    expect(out[0]?.content).toContain("2026-04-26");
    expect(out[0]?.content).toContain("The date has changed");
    expect(out[0]?.content).toContain("DO NOT mention this to the user");
  });

  test("renders critical_system_reminder verbatim", () => {
    const out = attachmentsToMessages([
      {
        kind: "critical_system_reminder",
        content: "Network outage detected; tools may fail.",
      },
    ]);
    expect(out[0]?.content).toContain("Network outage detected");
    expect(out[0]?.content).toContain("<system-reminder>");
  });

  test("renders output_style with the style name", () => {
    const out = attachmentsToMessages([
      { kind: "output_style", style: "minimal" },
    ]);
    expect(out[0]?.content).toContain("minimal output style is active");
    expect(out[0]?.content).toContain("specific guidelines");
  });

  test("renders deferred_tools_delta with added and removed lines", () => {
    const out = attachmentsToMessages([
      {
        kind: "deferred_tools_delta",
        addedNames: ["system.gitStatus"],
        addedLines: ["system.gitStatus: report repo state"],
        removedNames: ["system.symbolSearch"],
      },
    ]);
    expect(out[0]?.content).toContain(
      "The following deferred tools are now available via ToolSearch",
    );
    expect(out[0]?.content).toContain("system.gitStatus: report repo state");
    expect(out[0]?.content).toContain(
      "The following deferred tools are no longer available",
    );
    expect(out[0]?.content).toContain("system.symbolSearch");
  });

  test("renders agent_listing_delta in initial vs delta modes", () => {
    const initial = attachmentsToMessages([
      {
        kind: "agent_listing_delta",
        addedTypes: ["explore"],
        addedLines: ["explore — codebase exploration"],
        removedTypes: [],
        isInitial: true,
      },
    ]);
    const delta = attachmentsToMessages([
      {
        kind: "agent_listing_delta",
        addedTypes: ["plan-reviewer"],
        addedLines: ["plan-reviewer — review plans"],
        removedTypes: ["explore"],
        isInitial: false,
      },
    ]);
    expect(initial[0]?.content).toContain(
      "Available agent types for the Agent tool",
    );
    expect(initial[0]?.content).toContain("explore — codebase exploration");
    expect(delta[0]?.content).toContain(
      "New agent types are now available for the Agent tool",
    );
    expect(delta[0]?.content).toContain("plan-reviewer");
    expect(delta[0]?.content).toContain(
      "The following agent types are no longer available",
    );
  });

  test("renders mcp_instructions_delta with named blocks", () => {
    const out = attachmentsToMessages([
      {
        kind: "mcp_instructions_delta",
        addedNames: ["github"],
        addedBlocks: ["Use the github MCP for issues."],
        removedNames: ["jira"],
      },
    ]);
    expect(out[0]?.content).toContain("# MCP Server Instructions");
    expect(out[0]?.content).toContain(
      "provided instructions for how to use their tools and resources",
    );
    expect(out[0]?.content).toContain("Use the github MCP for issues.");
    expect(out[0]?.content).toContain(
      "Their instructions above no longer apply",
    );
    expect(out[0]?.content).toContain("jira");
  });

  test("renders edited_text_file with diff snippet", () => {
    const out = attachmentsToMessages([
      {
        kind: "edited_text_file",
        filename: "src/foo.ts",
        snippet: "@@ -1 +1 @@\n-old\n+new",
      },
    ]);
    expect(out[0]?.content).toContain("src/foo.ts");
    expect(out[0]?.content).toContain("@@ -1 +1 @@");
    expect(out[0]?.content).toContain("This change was intentional");
    expect(out[0]?.content).toContain("don't revert it unless the user asks");
  });

  test("renders edited_image_file as a multimodal message with text + image parts", () => {
    const out = attachmentsToMessages([
      {
        kind: "edited_image_file",
        filename: "diagram.png",
        content: "AAAA",
        mediaType: "image/png",
      },
    ]);
    expect(out).toHaveLength(1);
    expect(Array.isArray(out[0]?.content)).toBe(true);
    const parts = out[0]?.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({ type: "text" });
    expect(parts[1]).toMatchObject({ type: "image" });
  });

  test("renders agent_mention with the agent type", () => {
    const out = attachmentsToMessages([
      { kind: "agent_mention", agentType: "explore" },
    ]);
    expect(out[0]?.content).toContain("explore");
    expect(out[0]?.content).toContain(
      "expressed a desire to invoke the agent",
    );
  });

  test("uses AgenC branding and does not leak Claude-branded memory names", () => {
    const planFilePath = "/home/u/.agenc/plans/active.md";
    const rendered = attachmentsToMessages([
      { kind: "plan_mode", variant: "full", planFilePath, planExists: false },
      {
        kind: "nested_memory",
        path: "/repo/AGENC.md",
        displayPath: "AGENC.md",
        memoryType: "Project",
        content: "Project rules go here.",
        mtimeMs: 1_700_000_000_000,
      },
    ])
      .map((message) =>
        typeof message.content === "string" ? message.content : "",
      )
      .join("\n");

    expect(rendered).toContain("AGENC.md");
    expect(rendered).not.toContain("CLAUDE.md");
    expect(rendered).not.toContain("Claude Code");
  });

  test("preserves attachment ordering across mixed kinds", () => {
    const out = attachmentsToMessages([
      { kind: "date_change", newDate: "2026-04-26" },
      { kind: "auto_mode", variant: "sparse" },
      {
        kind: "edited_text_file",
        filename: "x.ts",
        snippet: "diff",
      },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]?.content).toContain("2026-04-26");
    expect(out[1]?.content).toContain("Auto mode is active");
    expect(out[2]?.content).toContain("x.ts");
  });
});
