import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createSessionToolHandler } from "../../../src/gateway/tool-handler-factory.js";
import { EffectLedger } from "../../../src/workflow/effect-ledger.js";
import { createMockMemoryBackend } from "../../../src/memory/test-utils.js";
import { validateDelegatedOutputContract } from "../../../src/utils/delegation-validation.js";

function createTempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function encodeEffectToolResult(effect: {
  readonly status?: string;
  readonly targets?: readonly unknown[];
  readonly preExecutionSnapshots?: readonly Array<{
    readonly path?: string;
    readonly exists?: boolean;
    readonly entryType?: string;
    readonly sizeBytes?: number;
    readonly sha256?: string;
  }>;
  readonly postExecutionSnapshots?: readonly Array<{
    readonly path?: string;
    readonly exists?: boolean;
    readonly entryType?: string;
    readonly sizeBytes?: number;
    readonly sha256?: string;
  }>;
}, path: string): string {
  return JSON.stringify({
    path,
    written: true,
    __agencEffect: {
      status: effect.status,
      targets: effect.targets,
      ...(effect.preExecutionSnapshots && effect.preExecutionSnapshots.length > 0
        ? {
            preExecutionSnapshots: effect.preExecutionSnapshots.map((snapshot) => ({
              path: snapshot.path,
              exists: snapshot.exists,
              entryType: snapshot.entryType,
              ...(typeof snapshot.sizeBytes === "number"
                ? { sizeBytes: snapshot.sizeBytes }
                : {}),
              ...(typeof snapshot.sha256 === "string"
                ? { sha256: snapshot.sha256 }
                : {}),
            })),
          }
        : {}),
      ...(effect.postExecutionSnapshots && effect.postExecutionSnapshots.length > 0
        ? {
            postExecutionSnapshots: effect.postExecutionSnapshots.map((snapshot) => ({
              path: snapshot.path,
              exists: snapshot.exists,
              entryType: snapshot.entryType,
              ...(typeof snapshot.sizeBytes === "number"
                ? { sizeBytes: snapshot.sizeBytes }
                : {}),
              ...(typeof snapshot.sha256 === "string"
                ? { sha256: snapshot.sha256 }
                : {}),
            })),
          }
        : {}),
    },
  });
}

describe("contract-backed verification integration", () => {
  it("accepts grounded no-op success when the target artifact was read and no mutation was needed", () => {
    const workspace = "/tmp/agenc-verification-noop";
    const targetPath = `${workspace}/AGENC.md`;
    const result = validateDelegatedOutputContract({
      spec: {
        task: "review_agenc_md",
        objective: "Verify AGENC.md already satisfies the requested sections.",
        inputContract: "Inspect the current guide before deciding whether edits are needed.",
        acceptanceCriteria: ["State that AGENC.md already satisfies the requested sections."],
        executionContext: {
          version: "v1",
          workspaceRoot: workspace,
          requiredSourceArtifacts: [targetPath],
          targetArtifacts: [targetPath],
          stepKind: "delegated_review",
          verificationMode: "grounded_read",
        },
      },
      output: "AGENC.md already satisfies the requested sections. No mutation needed.",
      toolCalls: [{
        name: "system.readFile",
        args: { path: targetPath },
        result: JSON.stringify({
          path: targetPath,
          content: "# Repository Guidelines\n",
        }),
        isError: false,
      }],
    });

    expect(result.ok).toBe(true);
  });

  it("accepts real mutation evidence from runtime artifact records even when the prose does not name files", async () => {
    const workspace = createTempDir("agenc-verification-write-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "old content", "utf8");
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const handler = createSessionToolHandler({
      sessionId: "subagent:verify-write",
      baseHandler: vi.fn(async (_toolName, args) => {
        writeFileSync(String(args.path), String(args.content), "utf8");
        return JSON.stringify({ path: args.path, written: true });
      }),
      availableToolNames: ["system.writeFile"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspace,
      effectLedger: ledger,
      effectChannel: "test",
    });

    try {
      await handler("system.writeFile", {
        path: targetPath,
        content: "new content",
      });
      const [effect] = await ledger.listSessionEffects("subagent:verify-write");
      expect(effect?.postExecutionSnapshots?.[0]?.path).toBe(targetPath);
      const writeResult = encodeEffectToolResult(effect ?? {}, targetPath);

      const result = validateDelegatedOutputContract({
        spec: {
          task: "write_agenc_md",
          objective: "Update the guide with the finalized repository rules.",
          inputContract: "Inspect the current guide before editing it.",
          acceptanceCriteria: ["State that the requested guide update completed."],
          executionContext: {
            version: "v1",
            workspaceRoot: workspace,
            requiredSourceArtifacts: [targetPath],
            targetArtifacts: [targetPath],
            stepKind: "delegated_write",
            verificationMode: "mutation_required",
          },
        },
        output: "Completed the requested guide update.",
        toolCalls: [
          {
            name: "system.listDir",
            args: { path: workspace },
            result: JSON.stringify({
              path: workspace,
              entries: [
                {
                  name: "AGENC.md",
                  type: "file",
                },
              ],
            }),
            isError: false,
          },
          {
            name: "system.readFile",
            args: { path: targetPath },
            result: JSON.stringify({
              path: targetPath,
              content: "old content",
            }),
            isError: false,
          },
          {
            name: "system.writeFile",
            args: { path: targetPath, content: "new content" },
            result: writeResult,
            isError: false,
          },
        ],
      });

      if (!result.ok) {
        throw new Error(
          `Expected delegated output contract success, received ${JSON.stringify(result, null, 2)}`,
        );
      }
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });

  it("accepts shell-based mutation evidence when effect records prove the target artifact changed", async () => {
    const workspace = createTempDir("agenc-verification-shell-");
    const targetPath = join(workspace, "AGENC.md");
    writeFileSync(targetPath, "old shell content", "utf8");
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const subAgentManager = {
      getInfo: vi.fn(() => ({
        sessionId: "subagent:verify-shell",
        parentSessionId: "session-parent",
        depth: 1,
        status: "running",
        startedAt: Date.now() - 100,
        task: "Patch the guide with shell",
      })),
      getExecutionContext: vi.fn(() => ({
        version: "v1",
        workspaceRoot: workspace,
        allowedReadRoots: [workspace],
        allowedWriteRoots: [workspace],
        targetArtifacts: [targetPath],
        requiredSourceArtifacts: [targetPath],
        effectClass: "shell",
      })),
    };
    const handler = createSessionToolHandler({
      sessionId: "subagent:verify-shell",
      baseHandler: vi.fn(async () => {
        writeFileSync(targetPath, "new shell content", "utf8");
        return JSON.stringify({ stdout: "ok", exitCode: 0 });
      }),
      availableToolNames: ["system.bash"],
      routerId: "router-a",
      send: vi.fn(),
      defaultWorkingDirectory: workspace,
      effectLedger: ledger,
      effectChannel: "test",
      delegation: () => ({
        subAgentManager: subAgentManager as any,
        policyEngine: null,
        verifier: null,
        lifecycleEmitter: null,
      }),
    });

    const shellResult = await handler("system.bash", {
      command: `printf 'new shell content' > "${targetPath}"`,
      cwd: workspace,
    });

    const validation = validateDelegatedOutputContract({
      spec: {
        task: "write_agenc_md",
        objective: "Update AGENC.md with the finalized repository guide.",
        inputContract: "Use the existing guide as the source of truth before modifying it.",
        acceptanceCriteria: ["State that AGENC.md was updated."],
        executionContext: {
          version: "v1",
          workspaceRoot: workspace,
          requiredSourceArtifacts: [targetPath],
          targetArtifacts: [targetPath],
          stepKind: "delegated_write",
          verificationMode: "mutation_required",
          effectClass: "shell",
        },
      },
      output: "Updated AGENC.md via shell after inspecting the existing guide.",
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: targetPath },
          result: JSON.stringify({
            path: targetPath,
            content: "old shell content",
          }),
          isError: false,
        },
        {
          name: "system.bash",
          args: {
            command: `printf 'new shell content' > "${targetPath}"`,
            cwd: workspace,
          },
          result: shellResult,
          isError: false,
        },
      ],
    });

    expect(validation.ok).toBe(true);

    rmSync(workspace, { recursive: true, force: true });
  });
});
