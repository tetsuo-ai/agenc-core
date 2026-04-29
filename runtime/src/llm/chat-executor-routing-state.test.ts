import { describe, expect, it } from "vitest";
import {
  applyActiveRoutedToolNames,
  getAllowedToolNamesForContractGuidance,
  getAllowedToolNamesForEvidence,
  resolveEffectiveRoutedToolNames,
} from "./chat-executor-routing-state.js";

describe("chat-executor-routing-state", () => {
  it("prefers the active routed subset for evidence checks", () => {
    expect(
      getAllowedToolNamesForEvidence(
        ["mcp.example.status"],
        ["desktop.bash", "mcp.example.start"],
      ),
    ).toEqual(["mcp.example.status"]);
  });

  it("keeps the broader turn universe available for contract guidance", () => {
    expect(
      getAllowedToolNamesForContractGuidance({
        activeRoutedToolNames: ["mcp.example.set_objective"],
        initialRoutedToolNames: ["desktop.bash", "mcp.example.start"],
        expandedRoutedToolNames: ["mcp.example.set_objective", "mcp.example.get_state"],
      }),
    ).toEqual([
      "desktop.bash",
      "mcp.example.start",
      "mcp.example.set_objective",
      "mcp.example.get_state",
    ]);
  });

  it("carries forward the current routed subset when no explicit override is provided", () => {
    expect(
      resolveEffectiveRoutedToolNames({
        hasToolRouting: true,
        activeRoutedToolNames: ["mcp.example.status"],
        allowedTools: ["desktop.bash", "mcp.example.start"],
      }),
    ).toEqual(["mcp.example.status"]);
  });

  it("falls back to allowed tools when routing exists but no route is active", () => {
    expect(
      resolveEffectiveRoutedToolNames({
        hasToolRouting: true,
        activeRoutedToolNames: [],
        allowedTools: ["desktop.bash", "mcp.example.start"],
      }),
    ).toEqual(["desktop.bash", "mcp.example.start"]);
  });

  it("preserves an explicitly empty routed override", () => {
    expect(
      resolveEffectiveRoutedToolNames({
        requestedRoutedToolNames: [],
        hasToolRouting: true,
        activeRoutedToolNames: ["mcp.example.status"],
        allowedTools: ["desktop.bash", "mcp.example.start"],
      }),
    ).toEqual([]);
  });

  it("normalizes and applies the active routed subset in one place", () => {
    const ctx = {
      activeRoutedToolNames: ["desktop.bash"],
    };

    expect(
      applyActiveRoutedToolNames(ctx, [
        " mcp.example.status ",
        "mcp.example.status",
        "",
      ]),
    ).toEqual(["mcp.example.status"]);
    expect(ctx.activeRoutedToolNames).toEqual(["mcp.example.status"]);
  });
});
