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
        "--dangerously-bypass-approvals-and-sandbox",
      ]),
    ).toEqual({
      optionArgs: [
        "--provider",
        "openai",
        "--model=gpt-5",
        "--permission-mode",
        "plan",
      ],
      promptArgs: ["explain", "--dangerously-bypass-approvals-and-sandbox"],
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
      tokenizeCliOptionRegion(["--future-flag", "its-value", "--dangerously-bypass-approvals-and-sandbox"]),
    ).toEqual({
      optionArgs: ["--future-flag"],
      promptArgs: ["its-value", "--dangerously-bypass-approvals-and-sandbox"],
      endedBy: "positional",
    });
  });

  it("treats a lone dash as positional prompt text", () => {
    expect(tokenizeCliOptionRegion(["-", "--dangerously-bypass-approvals-and-sandbox"])).toEqual({
      optionArgs: [],
      promptArgs: ["-", "--dangerously-bypass-approvals-and-sandbox"],
      endedBy: "positional",
    });
  });
});

describe("generated CLI option insertion", () => {
  it("inserts before positional prompt text", () => {
    expect(
      insertCliOptionsBeforePrompt(
        ["daemon", "status"],
        ["--permission-mode", "plan"],
      ),
    ).toEqual(["--permission-mode", "plan", "daemon", "status"]);
  });

  it("inserts before and preserves an explicit delimiter", () => {
    expect(
      insertProcessCliOptionsBeforePrompt(
        ["node", "agenc", "--", "--dangerously-bypass-approvals-and-sandbox"],
        ["--permission-mode", "plan"],
      ),
    ).toEqual([
      "node",
      "agenc",
      "--permission-mode",
      "plan",
      "--",
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
  });
});
