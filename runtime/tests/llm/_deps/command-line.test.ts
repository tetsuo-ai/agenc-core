import { describe, expect, it } from "vitest";

import { tokenizeShellCommand } from "../../../src/llm/_deps/command-line.js";

describe("tokenizeShellCommand", () => {
  it("keeps a file-descriptor prefix glued to its redirect operator", () => {
    expect(tokenizeShellCommand("rmdir tmp 2>/dev/null")).toEqual([
      "rmdir",
      "tmp",
      "2>",
      "/dev/null",
    ]);
    expect(tokenizeShellCommand("cmd 2>&1")).toEqual(["cmd", "2>&", "1"]);
    expect(tokenizeShellCommand("cmd 2>>err.log")).toEqual([
      "cmd",
      "2>>",
      "err.log",
    ]);
    expect(tokenizeShellCommand("cmd 0<input")).toEqual(["cmd", "0<", "input"]);
  });

  it("does not treat a digit operand separated by whitespace as a prefix", () => {
    expect(tokenizeShellCommand("sleep 2 > out")).toEqual([
      "sleep",
      "2",
      ">",
      "out",
    ]);
  });

  it("consumes the heredoc delimiter and skips the body", () => {
    const command = [
      "node --check game.js && node <<'JS'",
      "const s = { x: 0 };",
      "if (s.x === 0 && !r.pass) console.log(1 > 0);",
      "JS",
    ].join("\n");
    expect(tokenizeShellCommand(command)).toEqual([
      "node",
      "--check",
      "game.js",
      "&&",
      "node",
      "<<",
      "JS",
      ";",
    ]);
  });

  it("keeps tokenizing after the terminator line", () => {
    const command = [
      'cat > /tmp/x <<"EOF"',
      "if (a > b) {}",
      "EOF",
      "echo done",
    ].join("\n");
    expect(tokenizeShellCommand(command)).toEqual([
      "cat",
      ">",
      "/tmp/x",
      "<<",
      "EOF",
      ";",
      "echo",
      "done",
    ]);
  });

  it("strips leading tabs from terminator lines for <<-", () => {
    const command = ["cat <<-EOF", "\tbody > x", "\tEOF", "ls"].join("\n");
    expect(tokenizeShellCommand(command)).toEqual([
      "cat",
      "<<-",
      "EOF",
      ";",
      "ls",
    ]);
  });

  it("handles several heredocs on one line in order", () => {
    const command = ["cat <<A <<B", "a > 1", "A", "b > 2", "B", "pwd"].join("\n");
    expect(tokenizeShellCommand(command)).toEqual([
      "cat",
      "<<",
      "A",
      "<<",
      "B",
      ";",
      "pwd",
    ]);
  });

  it("runs an unterminated heredoc body to the end of the input", () => {
    const command = ["cat <<EOF", "never > closed", "still > open"].join("\n");
    expect(tokenizeShellCommand(command)).toEqual(["cat", "<<", "EOF", ";"]);
  });

  it("leaves here-strings alone", () => {
    expect(tokenizeShellCommand('cat <<< "text"')).toEqual([
      "cat",
      "<<",
      "<",
      "text",
    ]);
  });
});
