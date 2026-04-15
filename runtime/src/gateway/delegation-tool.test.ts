import { describe, expect, it } from "vitest";
import {
  createExecuteWithAgentTool,
  EXECUTE_WITH_AGENT_TOOL_NAME,
  parseExecuteWithAgentInput,
  resolveDelegatedWorkingDirectory,
} from "./delegation-tool.js";

describe("delegation-tool", () => {
  it("parses execute_with_agent input with task and scoped options", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect runtime planner flow",
      tools: ["system.readFile", "system.readFile", " system.listDir "],
      requiredToolCapabilities: ["system.readFile", "system.listDir"],
      timeoutMs: 25_000,
      acceptanceCriteria: ["return findings", "include one risk"],
      spawnDecisionScore: 0.77,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("inspect runtime planner flow");
    expect(parsed.value.tools).toEqual(["system.readFile", "system.listDir"]);
    expect(parsed.value.requiredToolCapabilities).toEqual([
      "system.readFile",
      "system.listDir",
    ]);
    expect(parsed.value.timeoutMs).toBe(25_000);
    expect(parsed.value.acceptanceCriteria).toEqual([
      "return findings",
      "include one risk",
    ]);
    expect(parsed.value.spawnDecisionScore).toBe(0.77);
  });

  it("accepts objective as task fallback", () => {
    const parsed = parseExecuteWithAgentInput({
      objective: "compare three modules",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("compare three modules");
    expect(parsed.value.objective).toBe("compare three modules");
  });

  it("parses forkContext on the public delegation path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "investigate the live failure",
      forkContext: true,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.forkContext).toBe(true);
  });

  it("parses an explicit child cwd on the public delegation path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect the generated project",
      cwd: "packages/app",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.cwd).toBe("packages/app");
  });

  it("preserves explicit task scope when task and objective are both provided", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "Inspect docs/RUNTIME_API.md sections 4b and 8",
      objective: "Extract one autonomy-validation risk with a direct reference",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.task).toBe("Inspect docs/RUNTIME_API.md sections 4b and 8");
    expect(parsed.value.objective).toBe(
      "Extract one autonomy-validation risk with a direct reference",
    );
  });

  it("parses internal continuation session identifiers without exposing them in the tool schema", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "continue the previous child",
      continuationSessionId: "subagent:child-7",
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.continuationSessionId).toBe("subagent:child-7");
  });

  it("ignores legacy context requirements on the direct execute_with_agent path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "implement files in the project workspace",
      context_requirements: [
        " repo_context ",
        "cwd = /home/tetsuo/agent-test/grid-router-ts ",
      ],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.executionContext).toBeUndefined();
  });

  it("accepts snake_case delegation fields from planner-shaped payloads", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "implement_core",
      input_contract: "Project scaffold already exists",
      acceptance_criteria: ["Write the core TypeScript files"],
      required_tool_capabilities: ["system.writeFile", "system.readFile"],
      context_requirements: ["cwd:/tmp/grid-router-ts"],
      spawn_decision_score: 0.42,
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.inputContract).toBe("Project scaffold already exists");
    expect(parsed.value.acceptanceCriteria).toEqual([
      "Write the core TypeScript files",
    ]);
    expect(parsed.value.requiredToolCapabilities).toEqual([
      "system.writeFile",
      "system.readFile",
    ]);
    expect(parsed.value.executionContext).toBeUndefined();
    expect(parsed.value.spawnDecisionScore).toBe(0.42);
  });

  it("rejects planner-shaped execution_context payloads on the public path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "write_agenc_md",
      execution_context: {
        workspace_root: "/tmp/agenc-shell",
        allowed_read_roots: ["/tmp/agenc-shell"],
        allowed_write_roots: ["/tmp/agenc-shell"],
        required_source_artifacts: ["/tmp/agenc-shell/PLAN.md"],
        target_artifacts: ["/tmp/agenc-shell/AGENC.md"],
        allowed_tools: ["system.readFile", "system.writeFile"],
        effect_class: "filesystem_write",
        verification_mode: "mutation_required",
        step_kind: "delegated_write",
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain('"execution_context"');
  });

  it("preserves only bounded artifact and verification hints on the public path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "write_agenc_md",
      executionContext: {
        requiredSourceArtifacts: ["/tmp/agenc-shell/PLAN.md"],
        targetArtifacts: ["/tmp/agenc-shell/AGENC.md"],
        allowedTools: ["system.readFile", "system.writeFile"],
        effectClass: "filesystem_write",
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
      },
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.executionContext).toEqual(
      expect.objectContaining({
        requiredSourceArtifacts: ["/tmp/agenc-shell/PLAN.md"],
        targetArtifacts: ["/tmp/agenc-shell/AGENC.md"],
        allowedTools: ["system.readFile", "system.writeFile"],
        effectClass: "filesystem_write",
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
      }),
    );
  });

  it("rejects model-authored delegated root authority on the public path", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect doc",
      executionContext: {
        workspaceRoot: "/tmp/canonical-root",
        allowedReadRoots: ["/tmp/canonical-root"],
        allowedWriteRoots: ["/tmp/canonical-root"],
      },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("executionContext.workspaceRoot");
    expect(parsed.error).toContain("first trusted child root");
  });

  it("does not infer a delegated working directory from objective text", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "scaffold",
        objective:
          "Create the npm workspace structure in /home/tetsuo/agent-test/terrain-router-ts-1 from scratch.",
      }),
    ).toBeUndefined();
  });

  it("does not infer a delegated working directory from change-directory phrasing", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "run",
        objective:
          "Change to /home/tetsuo/agent-test/terrain-router-ts-1 directory and execute npm run build.",
      }),
    ).toBeUndefined();
  });

  it("uses executionContext.workspaceRoot when present", () => {
    expect(
      resolveDelegatedWorkingDirectory({
        task: "inspect doc",
        executionContext: {
          version: "v1",
          workspaceRoot: "/workspace/docs",
        },
      }),
    ).toEqual({
      path: "/workspace/docs",
      source: "execution_envelope",
    });
  });

  it("uses only runtime-owned executionContext as delegated working-directory truth", () => {
    const parsed = parseExecuteWithAgentInput({
      task: "inspect doc",
      contextRequirements: ["cwd=/tmp/legacy-only"],
    });

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(
      resolveDelegatedWorkingDirectory({
        task: parsed.value.task,
        executionContext: {
          workspaceRoot: "/tmp/canonical-root",
        },
      }),
    ).toEqual({
      path: "/tmp/canonical-root",
      source: "execution_envelope",
    });
  });

  it("rejects missing task/objective", () => {
    const parsed = parseExecuteWithAgentInput({});
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("non-empty");
  });

  it("creates a canonical execute_with_agent tool definition", async () => {
    const tool = createExecuteWithAgentTool();
    expect(tool.name).toBe(EXECUTE_WITH_AGENT_TOOL_NAME);
    expect(tool.inputSchema.properties).not.toHaveProperty(
      "continuationSessionId",
    );
    expect(tool.inputSchema.properties).not.toHaveProperty(
      "contextRequirements",
    );
    expect(tool.inputSchema.properties).toHaveProperty("cwd");
    const executionContext = tool.inputSchema.properties.executionContext as {
      properties?: Record<string, unknown>;
    };
    expect(executionContext.properties).not.toHaveProperty("workspaceRoot");
    expect(executionContext.properties).not.toHaveProperty("allowedReadRoots");
    expect(executionContext.properties).not.toHaveProperty("allowedWriteRoots");
    const direct = await tool.execute({ task: "do work" });
    expect(direct.isError).toBe(true);
    expect(direct.content).toContain("session-scoped tool handler");
  });
});
