import { describe, expect, it } from "vitest";

import {
  parseDirectCommandLine,
  tokenizeShellCommand,
} from "./command-line.js";

describe("command-line", () => {
  it("tokenizes quoted arguments without shell operators", () => {
    expect(tokenizeShellCommand('git commit -m "hello world"')).toEqual([
      "git",
      "commit",
      "-m",
      "hello world",
    ]);
  });

  it("parses direct command lines into command plus args", () => {
    expect(parseDirectCommandLine('git status --short')).toEqual({
      command: "git",
      args: ["status", "--short"],
    });
  });

  it("rejects shell-style command lines", () => {
    expect(parseDirectCommandLine("git status --short | cat")).toBeUndefined();
    expect(parseDirectCommandLine("FOO=bar git status")).toBeUndefined();
  });

  it("preserves literal metacharacters, empty arguments, and escaped trailing space", () => {
    expect(parseDirectCommandLine("printf '' '|' \\> '\\$' end\\ ")).toEqual({
      command: "printf",
      args: ["", "|", ">", "\\$", "end "],
    });
  });

  it.each([
    "cat 2>&1", "cat <>file", 'cat <<< "text"', "echo hi &>>out",
    "cat |& wc", "echo $(pwd)", 'echo "$(pwd)"', "echo `pwd`",
    "echo $\\\n(pwd)", "echo 'open", 'echo "open', "echo trailing\\",
  ])("rejects shell syntax or malformed quoting: %s", (command) => {
    expect(parseDirectCommandLine(command)).toBeUndefined();
  });
});
