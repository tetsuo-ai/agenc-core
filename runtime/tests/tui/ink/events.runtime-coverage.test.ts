import { describe, expect, test } from "vitest";

import { ClickEvent } from "./events/click-event.js";
import { TerminalFocusEvent } from "./events/terminal-focus-event.js";

describe("Ink DOM events", () => {
  test("ClickEvent stores global and local click coordinates", () => {
    const event = new ClickEvent(12, 8, true);

    expect(event.col).toBe(12);
    expect(event.row).toBe(8);
    expect(event.localCol).toBe(0);
    expect(event.localRow).toBe(0);
    expect(event.cellIsBlank).toBe(true);
    expect(event.didStopImmediatePropagation()).toBe(false);

    event.localCol = 2;
    event.localRow = 3;
    event.stopImmediatePropagation();

    expect(event.localCol).toBe(2);
    expect(event.localRow).toBe(3);
    expect(event.didStopImmediatePropagation()).toBe(true);
  });

  test("TerminalFocusEvent records focus and blur event types", () => {
    expect(new TerminalFocusEvent("terminalfocus").type).toBe("terminalfocus");
    expect(new TerminalFocusEvent("terminalblur").type).toBe("terminalblur");
  });
});
