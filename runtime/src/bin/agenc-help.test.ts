import { describe, expect, it, vi } from "vitest";
import {
  detectStartupShortCircuit,
  formatCliHelpText,
  formatCliHelpTopicText,
  main,
} from "./agenc.js";
import {
  formatAgenCDaemonCliHelpText,
  parseAgenCDaemonCliArgs,
} from "../app-server/daemon-cli.js";

describe("agenc CLI help", () => {
  it("formats top-level CLI help with commands and examples", () => {
    const help = formatCliHelpText();
    expect(help).toContain("Usage: agenc [options] [PROMPT]");
    expect(help).toContain("agenc help [command]");
    expect(help).toContain("Commands:");
    expect(help).toContain("Examples:");
    expect(help).toContain("agenc agent start");
    expect(help).toContain("agenc mcp serve --transport stdio");
  });

  it("resolves help topics for every routed CLI command", () => {
    for (const topic of [
      "agent",
      "daemon",
      "login",
      "mcp",
      "permissions",
      "plugin",
      "providers",
      "state",
    ]) {
      const text = formatCliHelpTopicText(topic);
      expect(text, topic).not.toBeNull();
      expect(text, topic).toContain("Usage:");
      expect(text, topic).toContain("Examples:");
    }

    expect(formatCliHelpTopicText("plugins")).toBe(
      formatCliHelpTopicText("plugin"),
    );
    expect(formatCliHelpTopicText("unknown")).toBeNull();
  });

  it("detects -h and agenc help topic short-circuits", () => {
    expect(detectStartupShortCircuit(["-h"])).toEqual({
      kind: "help",
      text: formatCliHelpText(),
    });
    expect(detectStartupShortCircuit(["help", "agent"])).toEqual({
      kind: "help",
      text: formatCliHelpTopicText("agent")!,
    });
    expect(detectStartupShortCircuit(["help", "missing"])).toEqual({
      kind: "error",
      message:
        "unknown help topic: missing\nRun 'agenc help' to see available topics.",
    });
    expect(detectStartupShortCircuit(["help", "agent", "extra"])).toEqual({
      kind: "error",
      message: "help accepts at most one command topic",
    });
  });

  it("routes nested daemon help without starting the daemon", () => {
    expect(parseAgenCDaemonCliArgs(["daemon", "start", "--help"])).toEqual({
      kind: "help",
      text: formatAgenCDaemonCliHelpText(),
    });
  });

  it("main short-circuits agenc help <topic> before TUI routing", async () => {
    const prevArgv = [...process.argv];
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    process.argv = [
      "/usr/bin/node",
      "/opt/agenc/bin/agenc.js",
      "help",
      "permissions",
    ];

    try {
      const code = await main();
      expect(code).toBe(0);
      const stdout = stdoutSpy.mock.calls
        .map(([chunk]) => String(chunk))
        .join("");
      expect(stdout).toContain("agenc permissions approve");
      expect(stdout).toContain("Examples:");
      expect(stderrSpy).not.toHaveBeenCalled();
    } finally {
      process.argv = prevArgv;
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});
