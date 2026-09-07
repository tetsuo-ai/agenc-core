import { describe, expect, it } from "vitest";

import {
  getShellRedirectOperator,
  isDirectExecEligible,
  isShellCommandSeparator,
  lexShellCommand,
  SHELL_COMMAND_SEPARATORS,
  SHELL_REDIRECT_OPERATORS,
  tokenizeShellCommand,
} from "../../../src/utils/shell/command-line.js";
import { tokenizeShellCommand as llmTokenizer } from "../../../src/llm/_deps/command-line.js";
import { tokenizeShellCommand as systemTokenizer } from "../../../src/tools/system/command-line.js";

describe("shared shell lexer", () => {
  it("exports the same tokenizer through both compatibility modules", () => {
    expect(llmTokenizer).toBe(tokenizeShellCommand);
    expect(systemTokenizer).toBe(tokenizeShellCommand);
  });

  it.each([...SHELL_COMMAND_SEPARATORS, ...SHELL_REDIRECT_OPERATORS])(
    "recognizes the complete operator %s",
    (operator) => {
      const token = lexShellCommand(`first ${operator} second`).tokens[1]!;
      expect(token).toEqual({ kind: "operator", value: operator, requiresExpansion: false });
      expect(isShellCommandSeparator(token)).toBe(SHELL_COMMAND_SEPARATORS.has(operator));
      expect(getShellRedirectOperator(token)).toBe(
        SHELL_REDIRECT_OPERATORS.has(operator) ? operator : undefined,
      );
      expect(isDirectExecEligible(lexShellCommand(`first ${operator} second`))).toBe(false);
    },
  );

  it("takes the longest operator in a chain without whitespace", () => {
    expect(tokenizeShellCommand("first|&second&&third||fourth;fifth&>>out;;&last")).toEqual([
      "first", "|&", "second", "&&", "third", "||", "fourth", ";",
      "fifth", "&>>", "out", ";;&", "last",
    ]);
  });

  it.each(["'|'", '"&&"', "\\>", "'2>>'", "'<<'", "'&>'"])(
    "keeps a protected operator-looking argument as a word: %s",
    (argument) => {
      const parsed = lexShellCommand(`echo ${argument}`);
      expect(parsed.tokens[1]?.kind).toBe("word");
      expect(isShellCommandSeparator(parsed.tokens[1]!)).toBe(false);
      expect(getShellRedirectOperator(parsed.tokens[1]!)).toBeUndefined();
      expect(isDirectExecEligible(parsed)).toBe(true);
    },
  );

  it("attaches only adjacent unquoted numeric descriptors", () => {
    expect(tokenizeShellCommand("cmd 2>&1 3<>input 4>>out 5 >word '6'>quoted 7\\>literal")).toEqual([
      "cmd", "2>&", "1", "3<>", "input", "4>>", "out", "5", ">", "word",
      "6", ">", "quoted", "7>literal",
    ]);
  });

  it("preserves empty arguments and shell-specific double-quote escaping", () => {
    expect(tokenizeShellCommand(String.raw`printf '' "" a" b"'c' "\q\$\"\\"`)).toEqual([
      "printf", "", "", "a bc", '\\q$"\\',
    ]);
  });

  it("removes line continuations before matching words and operators", () => {
    expect(tokenizeShellCommand("printf ar\\\ng 2>\\\n>out &\\\n& echo done")).toEqual([
      "printf", "arg", "2>>", "out", "&&", "echo", "done",
    ]);
    expect(tokenizeShellCommand("printf 'a\\\nb'")).toEqual(["printf", "a\\\nb"]);
  });

  it("does not split on characters that the shell treats as word data", () => {
    expect(tokenizeShellCommand("printf a\rb\u00a0c")).toEqual(["printf", "a\rb\u00a0c"]);
  });

  it("skips comments only at word boundaries and resumes on the next line", () => {
    const parsed = lexShellCommand("echo x#y '#z' # ignored > out\npwd");
    expect(parsed.hasComment).toBe(true);
    expect(parsed.tokens.map((token) => token.value)).toEqual(["echo", "x#y", "#z", ";", "pwd"]);
    expect(isDirectExecEligible(parsed)).toBe(false);
  });

  it.each([
    "echo $(id)", 'echo "$(id)"', "echo `id`", 'echo "`id`"',
    "cat <(id)", "cat >(id)", "echo $\\\n(id)", 'echo "$\\\n(id)"',
  ])("flags active command substitution: %s", (command) => {
    const parsed = lexShellCommand(command);
    expect(parsed.hasCommandSubstitution).toBe(true);
    expect(isDirectExecEligible(parsed)).toBe(false);
  });

  it.each(["echo '$(id)'", "echo '`id`'", 'echo "\\$(id)"', "echo \\`id\\`"])(
    "does not flag literal substitution text: %s",
    (command) => {
      const parsed = lexShellCommand(command);
      expect(parsed.hasCommandSubstitution).toBe(false);
      expect(isDirectExecEligible(parsed)).toBe(true);
    },
  );

  it.each(["echo 'open", 'echo "open', "echo trailing\\", "echo \0", "cat <<", "cat <<EOF\nbody"])(
    "rejects malformed lexical input: %s",
    (command) => {
      const parsed = lexShellCommand(command);
      expect(parsed.malformed).toBe(true);
      expect(isDirectExecEligible(parsed)).toBe(false);
    },
  );

  it.each(["$value", '"$value"', "*.ts", "~", "{a,b}"])(
    "rejects direct execution when shell expansion is required: %s",
    (argument) => expect(isDirectExecEligible(lexShellCommand(`echo ${argument}`))).toBe(false),
  );

  it("tracks quoted heredoc bodies and resumes after each delimiter", () => {
    const command = ["cat <<'ONE' <<-TWO", "$(literal)", "ONE", "\tplain", "\tTWO", "pwd"].join("\n");
    const parsed = lexShellCommand(command);
    expect(parsed.malformed).toBe(false);
    expect(parsed.hasCommandSubstitution).toBe(false);
    expect(parsed.tokens.map((token) => token.value)).toEqual([
      "cat", "<<", "ONE", "<<-", "TWO", ";", "pwd",
    ]);
  });

  it("detects command substitution inside an unquoted heredoc", () => {
    expect(lexShellCommand("cat <<EOF\n$(id)\nEOF").hasCommandSubstitution).toBe(true);
    expect(lexShellCommand("cat <<EOF\n\\$(id)\nEOF").hasCommandSubstitution).toBe(false);
    expect(lexShellCommand("cat <<EOF\n$\\\n(id)\nEOF").hasCommandSubstitution).toBe(true);
  });

  it("joins unquoted heredoc lines before checking the delimiter", () => {
    const parsed = lexShellCommand("cat <<EOF\nEO\\\nF\necho after");
    expect(parsed.malformed).toBe(false);
    expect(parsed.tokens.map((token) => token.value)).toEqual(["cat", "<<", "EOF", ";", "echo", "after"]);
  });

  it("does not join quoted heredoc lines or escaped backslashes", () => {
    expect(tokenizeShellCommand("cat <<'EOF'\nEO\\\nF\nEOF\npwd")).toEqual(["cat", "<<", "EOF", ";", "pwd"]);
    expect(lexShellCommand("cat <<EOF\nbody\\\\\nEOF").malformed).toBe(false);
  });

  it("accepts an empty quoted heredoc delimiter", () => {
    expect(lexShellCommand("cat <<''\nbody\n\npwd").malformed).toBe(false);
    expect(tokenizeShellCommand("cat <<''\nbody\n\npwd")).toEqual(["cat", "<<", "", ";", "pwd"]);
  });

  it("fails closed for unsupported expanded heredoc delimiter syntax", () => {
    expect(lexShellCommand("cat <<$'EO\\x46'\nEOF\npwd").malformed).toBe(true);
  });

  it("does not consume a here-string as a heredoc body", () => {
    const parsed = lexShellCommand('cat <<< "text"\npwd');
    expect(parsed.malformed).toBe(false);
    expect(parsed.tokens.map((token) => token.value)).toEqual(["cat", "<<<", "text", ";", "pwd"]);
  });

  it("scans long backslash runs without regex backtracking", () => {
    const body = "\\".repeat(200_000) + "plain";
    const parsed = lexShellCommand(`cat <<EOF\n${body}\nEOF\npwd`);
    expect(parsed.malformed).toBe(false);
    expect(parsed.hasCommandSubstitution).toBe(false);
    expect(parsed.tokens.map((token) => token.value)).toEqual(["cat", "<<", "EOF", ";", "pwd"]);
  });
});
