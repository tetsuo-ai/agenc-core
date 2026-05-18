import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { sourceUrl } from "../../../helpers/source-path.ts";

import { selectAgenCTuiGlyphs } from "../../glyphs.js";
import { stringWidth } from "../../ink/stringWidth.js";
import {
  getTeamListFooterText,
  getTeammateDetailFooterText,
  getTeamsDialogPromptPreview,
} from "./TeamsDialog.layout.js";

const source = readFileSync(
  sourceUrl("tui/components/teams/TeamsDialog.tsx"),
  "utf8",
);

describe("TeamsDialog pane visibility actions", () => {
  test("hide calls backend before mutating hidden-pane state", () => {
    expect(source).toMatch(/backend\.hidePane\(teammate\.tmuxPaneId/);
    expect(source.indexOf("if (!hidden)")).toBeLessThan(
      source.indexOf("addHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show calls backend before removing hidden-pane state", () => {
    expect(source).toMatch(/backend\.showPane\(/);
    expect(source.indexOf("if (!shown)")).toBeLessThan(
      source.indexOf("removeHiddenPaneId(teamName, teammate.tmuxPaneId)"),
    );
  });

  test("show never uses the hidden teammate pane as its own join target", () => {
    expect(source).not.toContain("process.env.TMUX_PANE ?? teammate.tmuxPaneId");
    expect(source).toContain("`${SWARM_SESSION_NAME}:${SWARM_VIEW_WINDOW_NAME}`");
    expect(source).toMatch(/if \(targetPane === teammatePaneId\) return null/);
  });

  test("missing pane id or backend returns before backend lookup", () => {
    expect(source).toMatch(/if \(!teammate\.tmuxPaneId \|\| !teammate\.backendType\) \{/);
    expect(source).toContain("missing pane metadata");
  });

  test("team actions render failure messages instead of only logging", () => {
    expect(source).toContain("Cannot kill @");
    expect(source).toContain("Cannot view teammate output");
    expect(source).toContain("Cannot hide or show");
    expect(source).toContain("<ActionNotice notice={actionNotice} />");
  });

  test("task rows expose loading/error/empty states and avoid raw symbolic bullets", () => {
    expect(source).toContain("Loading tasks...");
    expect(source).toContain("Unable to load tasks:");
    expect(source).toContain("No tasks");
    expect(source).not.toContain("\\u25FC");
    expect(source).not.toContain("figures.tick");
  });
});

describe("TeamsDialog layout helpers", () => {
  test("ASCII footers use shared glyphs and clamp to terminal width", () => {
    const glyphs = selectAgenCTuiGlyphs({ AGENC_TUI_GLYPHS: "ascii" });
    const listFooter = getTeamListFooterText({
      glyphs,
      supportsHideShow: true,
      cycleModeShortcut: "shift+tab",
      columns: 44,
    });
    const detailFooter = getTeammateDetailFooterText({
      glyphs,
      supportsHideShow: true,
      cycleModeShortcut: "shift+tab",
      columns: 44,
    });

    expect(stringWidth(listFooter)).toBeLessThanOrEqual(43);
    expect(stringWidth(detailFooter)).toBeLessThanOrEqual(43);
    expect(listFooter).toContain("^/v select");
    expect(detailFooter).toContain("Left back");
    expect(listFooter).not.toContain("·");
    expect(detailFooter).not.toContain("←");
  });

  test("prompt preview reserves space for the expand hint and ASCII ellipsis", () => {
    const preview = getTeamsDialogPromptPreview(
      "write a detailed implementation plan ".repeat(8),
      40,
      false,
      "...",
    );

    expect(preview.showExpandHint).toBe(true);
    expect(preview.text).toContain("...");
    expect(stringWidth(`${preview.text} (p to expand)`)).toBeLessThanOrEqual(36);
  });

  test("expanded prompt preview returns full prompt", () => {
    const prompt = "write a detailed implementation plan ".repeat(8);
    expect(getTeamsDialogPromptPreview(prompt, 40, true, "...")).toEqual({
      text: prompt,
      showExpandHint: false,
    });
  });
});
