import { describe, expect, test } from "vitest";

import { Parser } from "./parser.js";

const ESC = "\x1b";
const BEL = "\x07";

describe("termio Parser", () => {
  test("segments plain text, wide graphemes, and embedded bells", () => {
    const parser = new Parser();

    expect(parser.feed(`a\u{1F600}\u{4E00}${BEL}b`)).toEqual([
      {
        graphemes: [
          { value: "a", width: 1 },
          { value: "\u{1F600}", width: 2 },
          { value: "\u{4E00}", width: 2 },
        ],
        style: expect.objectContaining({ bold: false }),
        type: "text",
      },
      { type: "bell" },
      {
        graphemes: [{ value: "b", width: 1 }],
        style: expect.objectContaining({ bold: false }),
        type: "text",
      },
    ]);
  });

  test("streams incomplete escape sequences and applies SGR style to following text", () => {
    const parser = new Parser();

    expect(parser.feed(`${ESC}[31`)).toEqual([]);
    const actions = parser.feed("mred");

    expect(actions).toEqual([
      {
        graphemes: [
          { value: "r", width: 1 },
          { value: "e", width: 1 },
          { value: "d", width: 1 },
        ],
        style: expect.objectContaining({
          fg: { name: "red", type: "named" },
        }),
        type: "text",
      },
    ]);

    parser.reset();
    expect(parser.style).toEqual(
      expect.objectContaining({
        bold: false,
        fg: { type: "default" },
      }),
    );
  });

  test("parses cursor, erase, scroll, and cursor style CSI sequences", () => {
    const parser = new Parser();

    expect(
      parser.feed(
        [
          `${ESC}[2A`,
          `${ESC}[B`,
          `${ESC}[3C`,
          `${ESC}[4D`,
          `${ESC}[5E`,
          `${ESC}[6F`,
          `${ESC}[7G`,
          `${ESC}[8;9H`,
          `${ESC}[10d`,
          `${ESC}[2J`,
          `${ESC}[1K`,
          `${ESC}[4X`,
          `${ESC}[3S`,
          `${ESC}[2T`,
          `${ESC}[4;20r`,
          `${ESC}[s`,
          `${ESC}[u`,
          `${ESC}[5 q`,
        ].join(""),
      ),
    ).toEqual([
      { action: { count: 2, direction: "up", type: "move" }, type: "cursor" },
      { action: { count: 1, direction: "down", type: "move" }, type: "cursor" },
      { action: { count: 3, direction: "forward", type: "move" }, type: "cursor" },
      { action: { count: 4, direction: "back", type: "move" }, type: "cursor" },
      { action: { count: 5, type: "nextLine" }, type: "cursor" },
      { action: { count: 6, type: "prevLine" }, type: "cursor" },
      { action: { col: 7, type: "column" }, type: "cursor" },
      { action: { col: 9, row: 8, type: "position" }, type: "cursor" },
      { action: { row: 10, type: "row" }, type: "cursor" },
      { action: { region: "all", type: "display" }, type: "erase" },
      { action: { region: "toStart", type: "line" }, type: "erase" },
      { action: { count: 4, type: "chars" }, type: "erase" },
      { action: { count: 3, type: "up" }, type: "scroll" },
      { action: { count: 2, type: "down" }, type: "scroll" },
      { action: { bottom: 20, top: 4, type: "setRegion" }, type: "scroll" },
      { action: { type: "save" }, type: "cursor" },
      { action: { type: "restore" }, type: "cursor" },
      {
        action: { blinking: true, style: "bar", type: "style" },
        type: "cursor",
      },
    ]);
  });

  test("parses private mode CSI sequences", () => {
    const parser = new Parser();

    expect(
      parser.feed(
        [
          `${ESC}[?25l`,
          `${ESC}[?25h`,
          `${ESC}[?1049h`,
          `${ESC}[?1049l`,
          `${ESC}[?2004h`,
          `${ESC}[?1000h`,
          `${ESC}[?1002h`,
          `${ESC}[?1003h`,
          `${ESC}[?1004l`,
        ].join(""),
      ),
    ).toEqual([
      { action: { type: "hide" }, type: "cursor" },
      { action: { type: "show" }, type: "cursor" },
      { action: { enabled: true, type: "alternateScreen" }, type: "mode" },
      { action: { enabled: false, type: "alternateScreen" }, type: "mode" },
      { action: { enabled: true, type: "bracketedPaste" }, type: "mode" },
      { action: { mode: "normal", type: "mouseTracking" }, type: "mode" },
      { action: { mode: "button", type: "mouseTracking" }, type: "mode" },
      { action: { mode: "any", type: "mouseTracking" }, type: "mode" },
      { action: { enabled: false, type: "focusEvents" }, type: "mode" },
    ]);
  });

  test("parses ESC sequences and reports unknown SS3/CSI sequences", () => {
    const parser = new Parser();

    expect(
      parser.feed(
        [
          `${ESC}c`,
          `${ESC}7`,
          `${ESC}8`,
          `${ESC}D`,
          `${ESC}M`,
          `${ESC}E`,
          `${ESC}H`,
          `${ESC}(B`,
          `${ESC}Z`,
          `${ESC}OA`,
          `${ESC}[?9999h`,
        ].join(""),
      ),
    ).toEqual([
      { type: "reset" },
      { action: { type: "save" }, type: "cursor" },
      { action: { type: "restore" }, type: "cursor" },
      { action: { count: 1, direction: "down", type: "move" }, type: "cursor" },
      { action: { count: 1, direction: "up", type: "move" }, type: "cursor" },
      { action: { count: 1, type: "nextLine" }, type: "cursor" },
      { sequence: `${ESC}Z`, type: "unknown" },
      { sequence: `${ESC}OA`, type: "unknown" },
      { sequence: `${ESC}[?9999h`, type: "unknown" },
    ]);
  });

  test("parses OSC title, hyperlink, tab status, and unknown actions", () => {
    const parser = new Parser();

    expect(
      parser.feed(
        [
          `${ESC}]0;Both titles${BEL}`,
          `${ESC}]1;Icon only${BEL}`,
          `${ESC}]2;Window only${BEL}`,
          `${ESC}]8;id=abc;https://example.com${BEL}`,
          `${ESC}]8;;${BEL}`,
          `${ESC}]21337;indicator=#ff0000;status=ready\\;set;status-color=#00ff00${BEL}`,
          `${ESC}]999;payload${BEL}`,
        ].join(""),
      ),
    ).toEqual([
      { action: { title: "Both titles", type: "both" }, type: "title" },
      { action: { name: "Icon only", type: "iconName" }, type: "title" },
      { action: { title: "Window only", type: "windowTitle" }, type: "title" },
      {
        action: {
          params: { id: "abc" },
          type: "start",
          url: "https://example.com",
        },
        type: "link",
      },
      { action: { type: "end" }, type: "link" },
      {
        action: {
          indicator: { b: 0, g: 0, r: 255, type: "rgb" },
          status: "ready;set",
          statusColor: { b: 0, g: 255, r: 0, type: "rgb" },
        },
        type: "tabStatus",
      },
      { sequence: `${ESC}]999;payload`, type: "unknown" },
    ]);
    expect(parser.inLink).toBe(false);
    expect(parser.linkUrl).toBeUndefined();
  });

  test("accepts OSC string terminator sequences", () => {
    const parser = new Parser();

    expect(parser.feed(`${ESC}]2;Window${ESC}\\`)).toEqual([
      { action: { title: "Window", type: "windowTitle" }, type: "title" },
    ]);
  });
});
