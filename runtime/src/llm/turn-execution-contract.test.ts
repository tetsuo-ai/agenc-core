import { describe, expect, it } from "vitest";

import { resolveTurnExecutionContract, deriveActiveTaskContext } from "./turn-execution-contract.js";
import type { GatewayMessage } from "../gateway/message.js";
import type { ActiveTaskContext } from "./turn-execution-contract-types.js";

function createMessage(content: string): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

describe("turn-execution-contract", () => {
  it("routes explicit single-artifact repair requests to the artifact-update contract", () => {
    const contract = resolveTurnExecutionContract({
      message: createMessage("Go through @PLAN.md, find any gaps, and fix them."),
      runtimeContext: { workspaceRoot: "/workspace" },
    });

    expect(contract.turnClass).toBe("artifact_update");
    expect(contract.ownerMode).toBe("artifact_owner");
    expect(contract.delegationPolicy).toBe("direct_owner");
    expect(contract.targetArtifacts).toEqual(["/workspace/PLAN.md"]);
    expect(contract.artifactTaskContract?.operationMode).toBe("review_and_update_if_needed");
  });

  it("routes implementation continuations to workflow implementation before tool execution", () => {
    const activeTaskContext: ActiveTaskContext = {
      version: 1,
      taskLineageId: "task-phase-0",
      contractFingerprint: "previous-phase-contract",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      displayArtifact: "PLAN.md",
    };

    const contract = resolveTurnExecutionContract({
      message: createMessage("Implement phase 0"),
      runtimeContext: {
        workspaceRoot: "/workspace",
        activeTaskContext,
      },
    });

    expect(contract.turnClass).toBe("workflow_implementation");
    expect(contract.ownerMode).toBe("workflow_owner");
    expect(contract.sourceArtifacts).toEqual(["/workspace/PLAN.md"]);
    expect(contract.targetArtifacts).toEqual(["/workspace/src/main.c"]);
    expect(contract.invalidReason).toBeUndefined();
  });

  it("gives implement-from-artifact requests workspace-wide mutable ownership by default", () => {
    const contract = resolveTurnExecutionContract({
      message: createMessage("I want you to implement @PLAN.md in full."),
      runtimeContext: { workspaceRoot: "/workspace" },
    });

    expect(contract.turnClass).toBe("workflow_implementation");
    expect(contract.ownerMode).toBe("workflow_owner");
    expect(contract.sourceArtifacts).toEqual(["/workspace/PLAN.md"]);
    expect(contract.targetArtifacts).toEqual(["/workspace"]);
    expect(contract.executionEnvelope?.targetArtifacts).toEqual(["/workspace"]);
  });

  it("derives carryover only for artifact-update and workflow-implementation contracts", () => {
    const dialogueContract = resolveTurnExecutionContract({
      message: createMessage("hello"),
      runtimeContext: { workspaceRoot: "/workspace" },
    });
    const artifactContract = resolveTurnExecutionContract({
      message: createMessage("Review @ROADMAP.md and fix any missing sections."),
      runtimeContext: { workspaceRoot: "/workspace" },
    });

    expect(deriveActiveTaskContext(dialogueContract)).toBeUndefined();
    expect(deriveActiveTaskContext(artifactContract)).toMatchObject({
      turnClass: "artifact_update",
      ownerMode: "artifact_owner",
      targetArtifacts: ["/workspace/ROADMAP.md"],
    });
  });
});
