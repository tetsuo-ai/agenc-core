import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createMockMemoryBackend } from "../../../src/memory/test-utils.js";
import { PipelineExecutor } from "../../../src/workflow/pipeline.js";
import type { SubAgentConfig, SubAgentResult } from "../../../src/gateway/sub-agent.js";
import { SubAgentOrchestrator } from "../../../src/gateway/subagent-orchestrator.js";
import { deriveDelegatedExecutionEnvelopeFromParent } from "../../../src/utils/delegation-execution-context.js";

class RecordingManager {
  private readonly entries = new Map<string, SubAgentResult>();
  private seq = 0;

  public readonly spawnCalls: SubAgentConfig[] = [];

  constructor(private readonly result: SubAgentResult) {}

  async spawn(config: SubAgentConfig): Promise<string> {
    const id = `sub-${++this.seq}`;
    this.spawnCalls.push(config);
    this.entries.set(id, {
      sessionId: id,
      ...this.result,
    });
    return id;
  }

  getResult(sessionId: string): SubAgentResult | null {
    return this.entries.get(sessionId) ?? null;
  }

  cancel(): boolean {
    return true;
  }
}

const TEMP_DIRS: string[] = [];

afterEach(() => {
  for (const path of TEMP_DIRS.splice(0, TEMP_DIRS.length)) {
    rmSync(path, { recursive: true, force: true });
  }
});

describe("execution envelope integration", () => {
  it("treats the structured execution envelope as authoritative over misleading prompt cwd hints", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-"));
    TEMP_DIRS.push(workspaceRoot);
    writeFileSync(join(workspaceRoot, "PLAN.md"), "# plan\n", "utf8");
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new RecordingManager({
      output: '{"status":"completed","summary":"wrote AGENC.md"}',
      success: true,
      durationMs: 12,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: `${workspaceRoot}/PLAN.md` },
          result: `{"path":"${workspaceRoot}/PLAN.md","content":"# plan"}`,
          isError: false,
          durationMs: 2,
        },
        {
          name: "system.writeFile",
          args: { path: `${workspaceRoot}/AGENC.md` },
          result: `{"path":"${workspaceRoot}/AGENC.md","written":true}`,
          isError: false,
          durationMs: 3,
        },
      ],
      stopReason: "completed",
    });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      unsafeBenchmarkMode: true,
    });

    const result = await orchestrator.execute({
      id: "planner:envelope:1",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Write AGENC.md from PLAN.md",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "write_agenc_md",
          stepType: "subagent_task",
          objective: "Write the repository guide",
          inputContract: "Use the current PLAN.md as the source of truth.",
          acceptanceCriteria: ["AGENC.md written with the required sections"],
          requiredToolCapabilities: ["system.readFile", "system.writeFile"],
          contextRequirements: ["cwd=/tmp/wrong-root"],
          executionContext: {
            version: "v1",
            workspaceRoot,
            allowedReadRoots: [workspaceRoot],
            allowedWriteRoots: [workspaceRoot],
            requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
            targetArtifacts: [`${workspaceRoot}/AGENC.md`],
            allowedTools: ["system.readFile", "system.writeFile"],
            effectClass: "filesystem_write",
            verificationMode: "mutation_required",
            stepKind: "delegated_write",
          },
          maxBudgetHint: "4m",
          canRunParallel: false,
        },
      ],
    });

    const directDerivation = deriveDelegatedExecutionEnvelopeFromParent({
      parentWorkspaceRoot: workspaceRoot,
      parentAllowedReadRoots: [workspaceRoot],
      parentAllowedWriteRoots: [workspaceRoot],
      requestedExecutionContext: {
        version: "v1",
        workspaceRoot,
        allowedReadRoots: [workspaceRoot],
        allowedWriteRoots: [workspaceRoot],
        requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
        targetArtifacts: [`${workspaceRoot}/AGENC.md`],
        allowedTools: ["system.readFile", "system.writeFile"],
        effectClass: "filesystem_write",
        verificationMode: "mutation_required",
        stepKind: "delegated_write",
      },
      requiresStructuredExecutionContext: true,
      source: "direct_live_path",
    });

    expect(result.status).toMatch(/^(?:completed|failed)$/);
    expect(directDerivation.ok).toBe(true);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]).toMatchObject({
      workingDirectory: directDerivation.ok
        ? directDerivation.workingDirectory
        : workspaceRoot,
      workingDirectorySource: "execution_envelope",
    });
    expect(manager.spawnCalls[0]?.tools).toEqual(
      expect.arrayContaining(["system.readFile", "system.writeFile"]),
    );
    expect(manager.spawnCalls[0]?.delegationSpec?.executionContext).toEqual(
      directDerivation.ok ? directDerivation.executionContext : undefined,
    );
  });

  it("derives planner child scope from trusted parent authority instead of treating workspace aliases as live root truth", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-"));
    TEMP_DIRS.push(workspaceRoot);
    writeFileSync(join(workspaceRoot, "PLAN.md"), "# plan\n", "utf8");
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new RecordingManager({
      output: '{"status":"completed","summary":"updated PLAN.md"}',
      success: true,
      durationMs: 12,
      completionState: "completed",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: `${workspaceRoot}/PLAN.md` },
          result: `{"path":"${workspaceRoot}/PLAN.md","content":"# plan"}`,
          isError: false,
          durationMs: 2,
        },
      ],
      stopReason: "completed",
    });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      unsafeBenchmarkMode: true,
    });

    const result = await orchestrator.execute({
      id: "planner:envelope:2",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Inspect PLAN.md",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "review_plan",
          stepType: "subagent_task",
          objective: "Review the implementation plan",
          inputContract: "Inspect PLAN.md in the delegated workspace.",
          acceptanceCriteria: ["PLAN.md inspected"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/workspace",
            allowedReadRoots: ["/workspace", workspaceRoot],
            allowedWriteRoots: [],
            requiredSourceArtifacts: [
              "/workspace/PLAN.md",
              `${workspaceRoot}/PLAN.md`,
            ],
            allowedTools: ["system.readFile"],
            effectClass: "read_only",
            verificationMode: "grounded_read",
            stepKind: "delegated_review",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    });

    const directDerivation = deriveDelegatedExecutionEnvelopeFromParent({
      parentWorkspaceRoot: workspaceRoot,
      parentAllowedReadRoots: [workspaceRoot],
      parentAllowedWriteRoots: [workspaceRoot],
      requestedExecutionContext: {
        version: "v1",
        allowedReadRoots: [workspaceRoot],
        allowedWriteRoots: [],
        requiredSourceArtifacts: [`${workspaceRoot}/PLAN.md`],
        allowedTools: ["system.readFile"],
        effectClass: "read_only",
        verificationMode: "grounded_read",
        stepKind: "delegated_review",
      },
      requiresStructuredExecutionContext: true,
      source: "direct_live_path",
    });

    expect(result.status).toBe("completed");
    expect(directDerivation.ok).toBe(true);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]).toMatchObject({
      workingDirectory: directDerivation.ok
        ? directDerivation.workingDirectory
        : workspaceRoot,
      workingDirectorySource: "execution_envelope",
    });
    expect(manager.spawnCalls[0]?.delegationSpec?.executionContext).toEqual(
      directDerivation.ok ? directDerivation.executionContext : undefined,
    );
  });

  it("rejects broken delegated contracts before any child execution begins", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-outside-"));
    TEMP_DIRS.push(workspaceRoot);
    TEMP_DIRS.push(outsideRoot);
    mkdirSync(join(workspaceRoot, "src"), { recursive: true });
    writeFileSync(join(outsideRoot, "PLAN.md"), "# plan\n", "utf8");
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new RecordingManager({
      output: '{"status":"completed","summary":"should not run"}',
      success: true,
      durationMs: 12,
      toolCalls: [],
      stopReason: "completed",
    });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
    });

    const result = await orchestrator.execute({
      id: "planner:envelope:3",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Inspect PLAN.md",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "review_plan",
          stepType: "subagent_task",
          objective: "Review the implementation plan",
          inputContract: "Inspect PLAN.md in the delegated workspace.",
          acceptanceCriteria: ["PLAN.md inspected"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: "/workspace",
            allowedReadRoots: ["/workspace"],
            allowedWriteRoots: [],
            requiredSourceArtifacts: [join(outsideRoot, "PLAN.md")],
            allowedTools: ["system.readFile"],
            effectClass: "filesystem_read",
            verificationMode: "evidence_only",
            stepKind: "delegated_analysis",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    });

    expect(result.status).toBe("failed");
    expect(manager.spawnCalls).toHaveLength(0);
    expect(result.error).toContain(
      "outside the trusted parent workspace authority",
    );
  });

  it("derives the same narrowed child envelope for planner and direct descendant-scoped work", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-"));
    const packageRoot = join(workspaceRoot, "packages", "shell");
    TEMP_DIRS.push(workspaceRoot);
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, "PLAN.md"), "# plan\n", "utf8");
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new RecordingManager({
      output: '{"status":"completed","summary":"inspected package plan"}',
      success: true,
      durationMs: 12,
      completionState: "completed",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: `${packageRoot}/PLAN.md` },
          result: `{"path":"${packageRoot}/PLAN.md","content":"# plan"}`,
          isError: false,
          durationMs: 2,
        },
      ],
      stopReason: "completed",
    });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      unsafeBenchmarkMode: true,
    });

    const requestedExecutionContext = {
      version: "v1" as const,
      workspaceRoot: packageRoot,
      allowedReadRoots: [packageRoot],
      allowedWriteRoots: [],
      requiredSourceArtifacts: [`${packageRoot}/PLAN.md`],
      allowedTools: ["system.readFile"],
      effectClass: "read_only" as const,
      verificationMode: "grounded_read" as const,
      stepKind: "delegated_review" as const,
    };

    const result = await orchestrator.execute({
      id: "planner:envelope:descendant-parity",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Inspect the shell package plan",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "review_shell_plan",
          stepType: "subagent_task",
          objective: "Review the shell package plan",
          inputContract: "Inspect the delegated PLAN.md under packages/shell.",
          acceptanceCriteria: ["packages/shell/PLAN.md inspected"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: ["cwd=/workspace/packages/shell"],
          executionContext: requestedExecutionContext,
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    });

    const directDerivation = deriveDelegatedExecutionEnvelopeFromParent({
      parentWorkspaceRoot: workspaceRoot,
      parentAllowedReadRoots: [workspaceRoot],
      parentAllowedWriteRoots: [workspaceRoot],
      requestedExecutionContext,
      requiresStructuredExecutionContext: true,
      source: "direct_live_path",
    });

    expect(result.status).toBe("completed");
    expect(directDerivation.ok).toBe(true);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]).toMatchObject({
      workingDirectory: directDerivation.ok
        ? directDerivation.workingDirectory
        : packageRoot,
      workingDirectorySource: "execution_envelope",
    });
    expect(manager.spawnCalls[0]?.delegationSpec?.executionContext).toEqual(
      directDerivation.ok ? directDerivation.executionContext : undefined,
    );
  });

  it("corrects planner child workspace roots that widen outside the trusted parent authority and discards hallucinated scope", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-"));
    const outsideRoot = mkdtempSync(join(tmpdir(), "agenc-envelope-outside-"));
    TEMP_DIRS.push(workspaceRoot);
    TEMP_DIRS.push(outsideRoot);
    const baseExecutor = new PipelineExecutor({
      toolHandler: async () => '{"stdout":"ok","exitCode":0}',
      memoryBackend: createMockMemoryBackend(),
    });
    const manager = new RecordingManager({
      output: '{"status":"completed","summary":"inspected workspace"}',
      success: true,
      durationMs: 12,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: `${workspaceRoot}/README.md` },
          result: `{"path":"${workspaceRoot}/README.md","content":"# readme"}`,
          isError: false,
          durationMs: 2,
        },
      ],
      stopReason: "completed",
    });
    const orchestrator = new SubAgentOrchestrator({
      fallbackExecutor: baseExecutor,
      resolveSubAgentManager: () => manager,
      pollIntervalMs: 5,
      unsafeBenchmarkMode: true,
    });

    const result = await orchestrator.execute({
      id: "planner:envelope:4",
      createdAt: Date.now(),
      context: { results: {} },
      steps: [],
      plannerContext: {
        parentRequest: "Inspect PLAN.md",
        history: [],
        memory: [],
        toolOutputs: [],
        workspaceRoot,
      },
      plannerSteps: [
        {
          name: "review_plan",
          stepType: "subagent_task",
          objective: "Review the implementation plan",
          inputContract: "Inspect PLAN.md in the delegated workspace.",
          acceptanceCriteria: ["PLAN.md inspected"],
          requiredToolCapabilities: ["system.readFile"],
          contextRequirements: [],
          executionContext: {
            version: "v1",
            workspaceRoot: outsideRoot,
            allowedReadRoots: [outsideRoot],
            allowedWriteRoots: [],
            requiredSourceArtifacts: [join(outsideRoot, "PLAN.md")],
            allowedTools: ["system.readFile"],
            effectClass: "filesystem_read",
            verificationMode: "evidence_only",
            stepKind: "delegated_analysis",
          },
          maxBudgetHint: "2m",
          canRunParallel: false,
        },
      ],
    });

    // Workspace root is corrected to the parent; hallucinated roots and
    // artifacts that referenced outsideRoot are silently discarded.
    // The child spawns with the corrected (parent) workspace instead of
    // being rejected outright.
    expect(result.status).toMatch(/^(?:completed|failed)$/);
    expect(manager.spawnCalls).toHaveLength(1);
    expect(manager.spawnCalls[0]?.workingDirectory).toBe(workspaceRoot);

    // Verify the derivation itself succeeds with corrected workspace
    const derivation = deriveDelegatedExecutionEnvelopeFromParent({
      parentWorkspaceRoot: workspaceRoot,
      requestedExecutionContext: {
        version: "v1",
        workspaceRoot: outsideRoot,
        allowedReadRoots: [outsideRoot],
        allowedWriteRoots: [],
        requiredSourceArtifacts: [join(outsideRoot, "PLAN.md")],
        allowedTools: ["system.readFile"],
        effectClass: "filesystem_read",
        verificationMode: "evidence_only",
        stepKind: "delegated_analysis",
      },
      requiresStructuredExecutionContext: true,
      source: "internal_planner_path",
    });
    expect(derivation.ok).toBe(true);
    if (derivation.ok) {
      expect(derivation.workingDirectory).toBe(workspaceRoot);
    }
  });
});
