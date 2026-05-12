import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const source = readFileSync(
  new URL("./TeamsDialog.tsx", import.meta.url),
  "utf8",
);

describe("TeamsDialog pane visibility actions", () => {
  test("hide calls backend before mutating hidden-pane state", () => {
    expect(source).toMatch(/backend\.hidePane\(teammate\.tmuxPaneId/);
    expect(source.indexOf("if (!hidden) return")).toBeLessThan(
      source.indexOf("addHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show calls backend before removing hidden-pane state", () => {
    expect(source).toMatch(/backend\.showPane\(/);
    expect(source.indexOf("if (!shown) return")).toBeLessThan(
      source.indexOf("removeHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show never uses the hidden teammate pane as its own join target", () => {
    expect(source).not.toContain("process.env.TMUX_PANE ?? teammate.tmuxPaneId");
    expect(source).toContain("`${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`");
    expect(source).toMatch(/if \(targetPane === teammatePaneId\) return null/);
  });

  test("missing pane id or backend returns before backend lookup", () => {
    expect(source).toMatch(/if \(!teammate\.tmuxPaneId \|\| !teammate\.backendType\) return/);
  });
});
