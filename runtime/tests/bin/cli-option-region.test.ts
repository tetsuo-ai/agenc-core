import { describe, expect, it } from "vitest";

import {
  insertCliOptionsBeforePrompt,
  insertProcessCliOptionsBeforePrompt,
  tokenizeCliOptionRegion,
} from "../../src/bin/cli-option-region.js";

describe("tokenizeCliOptionRegion", () => {
  it("lets known value options consume values before the positional prompt", () => {
    expect(
      tokenizeCliOptionRegion([
        "--provider",
        "openai",
        "--model=gpt-5",
        "--permission-mode",
        "plan",
        "explain",
        "--yolo",
      ]),
    ).toEqual({
      optionArgs: [
        "--provider",
        "openai",
        "--model=gpt-5",
        "--permission-mode",
        "plan",
      ],
      promptArgs: ["explain", "--yolo"],
      endedBy: "positional",
    });
  });

  it("ends at -- and excludes only the delimiter", () => {
    expect(
      tokenizeCliOptionRegion([
        "--model",
        "gpt-5",
        "--",
        "--permission-mode",
        "bypassPermissions",
      ]),
    ).toEqual({
      optionArgs: ["--model", "gpt-5"],
      promptArgs: ["--permission-mode", "bypassPermissions"],
      endedBy: "delimiter",
    });
  });

  it("keeps unknown option-looking tokens before the first positional", () => {
    expect(
      tokenizeCliOptionRegion(["--future-flag", "its-value", "--yolo"]),
    ).toEqual({
      optionArgs: ["--future-flag"],
      promptArgs: ["its-value", "--yolo"],
      endedBy: "positional",
    });
  });

  it("treats a lone dash as positional prompt text", () => {
    expect(tokenizeCliOptionRegion(["-", "--yolo"])).toEqual({
      optionArgs: [],
      promptArgs: ["-", "--yolo"],
      endedBy: "positional",
    });
  });
});

describe("generated CLI option insertion", () => {
  it("inserts before positional prompt text", () => {
    expect(
      insertCliOptionsBeforePrompt(
        ["daemon", "run"],
        ["--permission-mode", "plan"],
      ),
    ).toEqual(["--permission-mode", "plan", "daemon", "run"]);
  });

  it("inserts before and preserves an explicit delimiter", () => {
    expect(
      insertProcessCliOptionsBeforePrompt(
        ["node", "agenc", "--", "--yolo"],
        ["--permission-mode", "plan"],
      ),
    ).toEqual([
      "node",
      "agenc",
      "--permission-mode",
      "plan",
      "--",
      "--yolo",
    ]);
  });
});
