import test from "node:test";
import assert from "node:assert/strict";

import {
  buildAltScreenEnterSequence,
  buildAltScreenLeaveSequence,
  buildTerminalHyperlinkSequence,
  parseMouseWheelSequence,
  supportsTerminalHyperlinks,
} from "../../src/watch/agenc-watch-terminal-sequences.mjs";

test("terminal sequences leave mouse tracking disabled by default", () => {
  assert.doesNotMatch(buildAltScreenEnterSequence(), /\?1000h/);
  assert.doesNotMatch(buildAltScreenEnterSequence(), /\?1002h/);
  assert.doesNotMatch(buildAltScreenEnterSequence(), /\?1006h/);
  assert.doesNotMatch(buildAltScreenEnterSequence(), /\?1007h/);
  assert.match(buildAltScreenEnterSequence(), /\?2004h/);
  assert.doesNotMatch(buildAltScreenLeaveSequence(), /\?1000l/);
  assert.doesNotMatch(buildAltScreenLeaveSequence(), /\?1002l/);
  assert.doesNotMatch(buildAltScreenLeaveSequence(), /\?1006l/);
  assert.doesNotMatch(buildAltScreenLeaveSequence(), /\?1007l/);
  assert.match(buildAltScreenLeaveSequence(), /\?2004l/);
});

test("terminal sequences enable SGR mouse reporting without alternate scroll mode (1007)", () => {
  // 1007 (DECSET alternate scroll mode) translates wheel events into
  // arrow-key escapes, which suppresses SGR 1006 mouse reports and
  // misroutes wheel scroll to composer history. We deliberately opt
  // INTO 1000/1002/1006 for mouse tracking but skip 1007.
  const enter = buildAltScreenEnterSequence({ enableMouseTracking: true });
  assert.match(enter, /\?1000h/);
  assert.match(enter, /\?1002h/);
  assert.match(enter, /\?1006h/);
  assert.doesNotMatch(enter, /\?1007h/);
  assert.match(buildAltScreenEnterSequence(), /\?2004h/);
  const leave = buildAltScreenLeaveSequence({ enableMouseTracking: true });
  assert.match(leave, /\?1000l/);
  assert.match(leave, /\?1002l/);
  assert.match(leave, /\?1006l/);
  assert.doesNotMatch(leave, /\?1007l/);
  assert.match(buildAltScreenLeaveSequence(), /\?2004l/);
});

test("parseMouseWheelSequence parses sgr wheel events", () => {
  assert.deepEqual(parseMouseWheelSequence("\x1b[<64;10;20M"), {
    length: "\x1b[<64;10;20M".length,
    delta: 3,
    isWheel: true,
  });
  assert.deepEqual(parseMouseWheelSequence("\x1b[<65;10;20M"), {
    length: "\x1b[<65;10;20M".length,
    delta: -3,
    isWheel: true,
  });
});

test("parseMouseWheelSequence ignores non-wheel sgr mouse packets", () => {
  assert.deepEqual(parseMouseWheelSequence("\x1b[<0;10;20M"), {
    length: "\x1b[<0;10;20M".length,
    delta: 0,
    isWheel: false,
  });
  assert.equal(parseMouseWheelSequence("plain text"), null);
});

test("supportsTerminalHyperlinks detects safe defaults and force flags", () => {
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: true },
      env: { TERM: "xterm-256color", WT_SESSION: "1" },
    }),
    true,
  );
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: true },
      env: { TERM: "dumb" },
    }),
    false,
  );
  assert.equal(
    supportsTerminalHyperlinks({
      stream: { isTTY: false },
      env: { AGENC_WATCH_ENABLE_HYPERLINKS: "1" },
    }),
    true,
  );
});

test("buildTerminalHyperlinkSequence wraps content in OSC 8 escapes", () => {
  assert.equal(
    buildTerminalHyperlinkSequence("runtime/src/index.ts", "file:///tmp/runtime/src/index.ts"),
    "\u001b]8;;file:///tmp/runtime/src/index.ts\u0007runtime/src/index.ts\u001b]8;;\u0007",
  );
});
