import assert from "node:assert/strict";

import { normalizePtyOutput, renderPtyScreen, stripAnsi } from "./harness.mjs";

const cursorRepaint = "hello\rhe\x1b[2C!";

assert.equal(stripAnsi(cursorRepaint), "hello\rhe!");
assert.equal(renderPtyScreen(cursorRepaint, { cols: 20, rows: 4 }), "hell!");
assert.match(
  normalizePtyOutput(cursorRepaint, { cols: 20, rows: 4 }),
  /hell!/u,
);

const positioned = "\x1b[2J\x1b[3;5HCreate\x1b[1Cskill";
assert.equal(
  renderPtyScreen(positioned, { cols: 20, rows: 6 }),
  "    Create skill",
);

const scrolling = "one\ntwo\nthree\nfour";
assert.equal(
  renderPtyScreen(scrolling, { cols: 20, rows: 3 }),
  "two\nthree\nfour",
);

const autowrapScrolling = "12345abcdeXYZ";
assert.equal(
  renderPtyScreen(autowrapScrolling, { cols: 5, rows: 2 }),
  "abcde\nXYZ",
);

const delayedAutowrap = "12345\rA";
assert.equal(
  renderPtyScreen(delayedAutowrap, { cols: 5, rows: 2 }),
  "A2345",
);
