import { describe, expect, it } from "vitest";
import {
  ACTIVE_TASK_CONTEXT_HEADER_PREFIX,
  buildActiveTaskContextMessage,
  shouldInjectActiveTaskContext,
} from "./active-task-context-prompt.js";
import type { ActiveTaskContext } from "./turn-execution-contract-types.js";
import type { LLMMessage } from "./types.js";

function contextOf(
  overrides: Partial<ActiveTaskContext> = {},
): ActiveTaskContext {
  return {
    version: 1,
    taskLineageId: "lineage-a",
    contractFingerprint: "fp-1",
    turnClass: "workflow_implementation",
    ownerMode: "workflow_owner",
    sourceArtifacts: ["/w/a.ts"],
    targetArtifacts: ["/w/b.ts"],
    ...overrides,
  };
}

describe("shouldInjectActiveTaskContext", () => {
  it("returns false when there is no context", () => {
    expect(
      shouldInjectActiveTaskContext({
        history: [],
        activeTaskContext: undefined,
      }),
    ).toBe(false);
  });

  it("injects on first turn with a context", () => {
    expect(
      shouldInjectActiveTaskContext({
        history: [],
        activeTaskContext: contextOf(),
      }),
    ).toBe(true);
  });

  it("skips injection when the prior block fingerprint matches", () => {
    const context = contextOf({ contractFingerprint: "abc" });
    const prior = buildActiveTaskContextMessage(context);
    expect(
      shouldInjectActiveTaskContext({
        history: [prior],
        activeTaskContext: context,
      }),
    ).toBe(false);
  });

  it("re-injects when the fingerprint changes", () => {
    const oldContext = contextOf({ contractFingerprint: "abc" });
    const prior = buildActiveTaskContextMessage(oldContext);
    expect(
      shouldInjectActiveTaskContext({
        history: [prior],
        activeTaskContext: contextOf({ contractFingerprint: "xyz" }),
      }),
    ).toBe(true);
  });

  it("re-injects only based on the most recent block", () => {
    const old = buildActiveTaskContextMessage(
      contextOf({ contractFingerprint: "old" }),
    );
    const current = buildActiveTaskContextMessage(
      contextOf({ contractFingerprint: "current" }),
    );
    expect(
      shouldInjectActiveTaskContext({
        history: [old, current],
        activeTaskContext: contextOf({ contractFingerprint: "current" }),
      }),
    ).toBe(false);
  });
});

describe("buildActiveTaskContextMessage", () => {
  it("includes workspaceRoot and both artifact lists", () => {
    const msg = buildActiveTaskContextMessage(
      contextOf({
        workspaceRoot: "/w",
        sourceArtifacts: ["/w/a.ts", "/w/b.ts"],
        targetArtifacts: ["/w/out.ts"],
      }),
    );
    const content =
      typeof msg.content === "string"
        ? msg.content
        : msg.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    expect(content).toContain(ACTIVE_TASK_CONTEXT_HEADER_PREFIX);
    expect(content).toContain("workspaceRoot: /w");
    expect(content).toContain("sourceArtifacts: /w/a.ts, /w/b.ts");
    expect(content).toContain("targetArtifacts: /w/out.ts");
  });

  it("shows (none) for empty artifact lists", () => {
    const msg = buildActiveTaskContextMessage(
      contextOf({ sourceArtifacts: [], targetArtifacts: [] }),
    );
    const content = msg.content as string;
    expect(content).toContain("sourceArtifacts: (none)");
    expect(content).toContain("targetArtifacts: (none)");
  });

  it("truncates long artifact lists and counts the overflow", () => {
    const sources = Array.from({ length: 12 }, (_, i) => `/w/s${i}.ts`);
    const msg = buildActiveTaskContextMessage(contextOf({ sourceArtifacts: sources }));
    const content = msg.content as string;
    expect(content).toContain("/w/s0.ts");
    expect(content).toContain("/w/s7.ts");
    expect(content).toContain("+4 more");
  });

  it("carries user role and runtime-only merge boundary plus anchor preserve", () => {
    const msg = buildActiveTaskContextMessage(contextOf());
    expect(msg.role).toBe("user");
    expect(msg.runtimeOnly?.mergeBoundary).toBe("user_context");
    expect(msg.runtimeOnly?.anchorPreserve).toBe(true);
  });

  it("omits optional fields when the context does not supply them", () => {
    const msg = buildActiveTaskContextMessage(contextOf());
    const content = msg.content as string;
    expect(content).not.toContain("workspaceRoot:");
    expect(content).not.toContain("displayArtifact:");
  });

  it("embeds the contract fingerprint so subsequent turns can dedup", () => {
    const msg = buildActiveTaskContextMessage(
      contextOf({ contractFingerprint: "deadbeef" }),
    );
    const content = msg.content as string;
    expect(content).toContain("context-fingerprint:deadbeef");
  });
});

describe("idempotent across consecutive turns", () => {
  it("a second collectAttachments-like call with identical context yields no new block", () => {
    const context = contextOf({ contractFingerprint: "same" });
    const first = buildActiveTaskContextMessage(context);
    const history: LLMMessage[] = [first];
    expect(
      shouldInjectActiveTaskContext({
        history,
        activeTaskContext: context,
      }),
    ).toBe(false);
  });
});
