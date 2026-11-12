import { describe, expect, it } from "vitest";

import {
  extractOutputRedirections,
  splitCommand_DEPRECATED,
} from "../../../src/utils/bash/commands.js";

// These helpers read shell command text through shell-quote's parse(), and
// the read-only grant and the path checks build on what they return. The
// cases below pin the readings that depend on the shell-quote version in the
// lockfile (1.11.0):
//
// - 1.12.0 returns `>|`, `&>`, `&>>` and `<>` as single operators. The
//   redirection code expects them as two tokens, so under 1.12.0 the write
//   target of those forms is no longer captured and nothing flags the
//   command. Do not move to 1.12 or later without teaching
//   extractOutputRedirections and the operator types about those tokens.
// - 1.10.0 did not decode $'...' quoting and read a double backslash before
//   a closing quote as an escaped quote.

describe("extractOutputRedirections", () => {
  it.each([
    ["echo x > out.txt", ">"],
    ["echo x >> out.txt", ">>"],
    ["echo x >| out.txt", ">"],
    ["echo x 2>| out.txt", ">"],
    ["echo x &> out.txt", ">"],
    ["echo x &>> out.txt", ">>"],
    ["echo x >& out.txt", ">"],
    ["cat <> out.txt", ">"],
  ] as const)("captures the file that %j writes", (command, operator) => {
    const result = extractOutputRedirections(command);

    expect(result.redirections).toEqual([{ target: "out.txt", operator }]);
    expect(result.hasDangerousRedirection).toBe(false);
  });

  it("captures a target written in $'...' quoting as the file bash opens", () => {
    const result = extractOutputRedirections("echo x > $'out.txt'");

    expect(result.redirections).toEqual([{ target: "out.txt", operator: ">" }]);
    expect(result.hasDangerousRedirection).toBe(false);
  });

  it("leaves a command without a redirection alone", () => {
    expect(extractOutputRedirections("echo x")).toEqual({
      commandWithoutRedirections: "echo x",
      redirections: [],
      hasDangerousRedirection: false,
    });
  });
});

describe("splitCommand_DEPRECATED", () => {
  it("splits at an operator that follows a quoted string ending in a backslash", () => {
    // In bash "a\\" is the string a\ and the quote closes, so `;` separates
    // two commands. Reading \\" as an escaped quote would hide the second.
    expect(splitCommand_DEPRECATED('git diff "a\\\\" ; touch p "b"')).toHaveLength(2);
    expect(splitCommand_DEPRECATED('git diff "a\\\\" ; touch p "b"')[1]).toBe(
      'touch p "b"',
    );
  });

  it("keeps a separator inside $'...' quoting as text", () => {
    expect(splitCommand_DEPRECATED("echo $'a;b'")).toEqual(["echo 'a;b'"]);
    expect(splitCommand_DEPRECATED("echo a && echo b")).toEqual(["echo a", "echo b"]);
  });
});
