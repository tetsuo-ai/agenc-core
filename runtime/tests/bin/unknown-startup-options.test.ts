import { describe, expect, it, vi } from "vitest";
import { classifyCLI, routeCLI, stripRoutingFlags } from "../../src/bin/route.js";

const executable = ["/usr/bin/node", "/opt/agenc/agenc.js"];

describe("unknown startup options", () => {
  it("does not call any startup implementation for an unsupported flag", async () => {
    const start = vi.fn(async () => 0);
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    try {
      expect(await routeCLI({
        argv: [...executable, "-p", "--max-budget-usd", "2", "write code"],
        isTTY: false,
        isStdoutTTY: false,
        bootTUI: start,
        oneShotCLI: start,
        resumeTUI: start,
        continueTUI: start,
      })).toBe(2);
      expect(start).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unknown option '--max-budget-usd'"));
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([true, false])("rejects options before routing when tty=%s", (isTTY) => {
    for (const option of ["--max-budget-usd", "--max-budget-usd=2", "--sandbox", "--fork", "-unknown", "--print=yes"]) {
      expect(classifyCLI({ argv: [...executable, option, "2", "build something"], isTTY, isStdoutTTY: isTTY })).toEqual({
        kind: "errorAndExit",
        message: `agenc: unknown option '${option}'. Use '--' before literal prompt text that starts with '-'.`,
        exitCode: 2,
      });
    }
  });

  it("preserves literal options after either prompt boundary", () => {
    for (const prompt of [["--", "--max-budget-usd", "2"], ["explain", "--max-budget-usd", "2"]]) {
      expect(classifyCLI({ argv: [...executable, "-p", ...prompt], isTTY: false, isStdoutTTY: false })).toMatchObject({
        kind: "oneShotCLI",
        userMessage: prompt.filter((token) => token !== "--").join(" "),
      });
    }
  });

  it.each(["--debug", "-d", "--debug=permissions", "--debug-to-stderr", "-d2e", "--debug-file=/tmp/debug.log"])("preserves supported debug option %s without sending it to the model", (option) => {
    expect(classifyCLI({ argv: [...executable, "-p", option, "hello"], isTTY: false, isStdoutTTY: false })).toEqual({ kind: "oneShotCLI", userMessage: "hello" });
    expect(stripRoutingFlags([option, "hello"])).toEqual(["hello"]);
  });

  it("consumes debug-file values before validating the next option", () => {
    expect(classifyCLI({ argv: [...executable, "-p", "--debug-file", "/tmp/debug.log", "--wrong"], isTTY: false, isStdoutTTY: false })).toMatchObject({ kind: "errorAndExit", exitCode: 2 });
    expect(stripRoutingFlags(["--debug-file", "/tmp/debug.log", "hello"])).toEqual(["hello"]);
  });
});
