import { describe, expect, test } from "vitest";

import { stringWidth } from "../../../src/tui/ink/stringWidth.js";
import type { AgenCTuiGlyphs } from "../../../src/tui/glyphs.js";
import {
  fitTeamsDialogFooter,
  getTeamListFooterText,
  getTeammateDetailFooterText,
  getTeamsDialogContentColumns,
  getTeamsDialogPromptPreview,
} from "../../../src/tui/components/teams/TeamsDialog.layout.js";

const glyphs: AgenCTuiGlyphs = {
  arrowUp: "^",
  arrowDown: "v",
  check: "*",
  cross: "x",
  ellipsis: "...",
  horizontal: "-",
  pointer: ">",
  separator: "|",
  vertical: "|",
};

describe("TeamsDialog.layout coverage swarm row 201", () => {
  test("normalizes unusable content widths to one column", () => {
    expect(getTeamsDialogContentColumns(Number.NaN)).toBe(1);
    expect(getTeamsDialogContentColumns(Number.POSITIVE_INFINITY)).toBe(1);
    expect(getTeamsDialogContentColumns(-12)).toBe(1);
    expect(getTeamsDialogContentColumns(7.9)).toBe(3);
  });

  test("truncates footers for non-finite and tiny terminal widths", () => {
    expect(fitTeamsDialogFooter("abcdef", Number.NaN, "...")).toBe(".");
    expect(fitTeamsDialogFooter("abcdef", 3, "...")).toBe("..");
    expect(fitTeamsDialogFooter("abcdef", 4, "...")).toBe("...");
    expect(fitTeamsDialogFooter("abc", 12, "...")).toBe("abc");
  });

  test("omits hide and show actions when terminal support is disabled", () => {
    const listFooter = getTeamListFooterText({
      glyphs,
      supportsHideShow: false,
      cycleModeShortcut: "tab",
      columns: 500,
    });
    const detailFooter = getTeammateDetailFooterText({
      glyphs,
      supportsHideShow: false,
      cycleModeShortcut: "tab",
      columns: 500,
    });

    expect(listFooter).toContain("^/v select");
    expect(listFooter).toContain("tab sync cycle modes for all");
    expect(listFooter).not.toContain("hide/show");
    expect(detailFooter).toContain("Left back");
    expect(detailFooter).toContain("tab cycle mode");
    expect(detailFooter).not.toContain("hide/show");
  });

  test("returns empty and short prompt previews without expansion hints", () => {
    expect(getTeamsDialogPromptPreview(undefined, 20, false, "...")).toEqual({
      text: "",
      showExpandHint: false,
    });
    expect(getTeamsDialogPromptPreview("short prompt", 40, false, "...")).toEqual(
      {
        text: "short prompt",
        showExpandHint: false,
      },
    );
  });

  test("truncates narrow prompt previews without reserving expand hint space", () => {
    expect(getTeamsDialogPromptPreview("abcdef", 7, false, "...")).toEqual({
      text: "...",
      showExpandHint: false,
    });
    expect(getTeamsDialogPromptPreview("abcdef", 5, false, "...")).toEqual({
      text: ".",
      showExpandHint: false,
    });
  });

  test("truncates prompt previews on grapheme boundaries before adding ellipsis", () => {
    const preview = getTeamsDialogPromptPreview("ab👍cdef", 11, false, "...");

    expect(preview).toEqual({
      text: "ab👍...",
      showExpandHint: false,
    });
    expect(stringWidth(preview.text)).toBe(7);
  });
});
