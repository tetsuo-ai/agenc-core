import { describe, expect, test, vi } from "vitest";

vi.mock("bun:bundle", () => ({
  feature: (name: string) => {
    const stack = new Error().stack ?? "";
    if (!stack.includes("PermissionRequest.tsx")) {
      return false;
    }
    return name === "REVIEW_ARTIFACT" || name === "WORKFLOW_SCRIPTS";
  },
}));

vi.mock("../../hooks/useNotifyAfterTimeout.js", () => ({
  useNotifyAfterTimeout: () => {},
}));

vi.mock("../../keybindings/useKeybinding.js", () => ({
  useKeybinding: () => {},
}));

describe("PermissionRequest unsupported feature paths", () => {
  test("maps enabled review-artifact and workflow feature placeholders to fallback UI", async () => {
    const { __permissionRequestTest } = await import("./PermissionRequest.js");
    const state = __permissionRequestTest.unsupportedFeatureState();

    expect(state.reviewArtifactTool).toEqual(
      expect.objectContaining({ name: "review artifact" }),
    );
    expect(state.reviewArtifactPermissionRequest).toBeTypeOf("function");
    expect(state.workflowTool).toEqual(expect.objectContaining({ name: "workflow" }));
    expect(state.workflowPermissionRequest).toBeTypeOf("function");
    expect(state.reviewArtifactTool?.renderToolUseMessage({}, { theme: "dark", verbose: true })).toBe(
      "review artifact",
    );
    expect(state.workflowTool?.renderToolUseMessage({}, { theme: "dark", verbose: true })).toBe(
      "workflow",
    );
  });
});
