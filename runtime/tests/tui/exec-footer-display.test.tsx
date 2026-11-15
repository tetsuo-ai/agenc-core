import { describe, expect, test, vi } from "vitest";

// Same ink stub as tests/tools/tool-rendering-bash.test.tsx: the real ink chain
// pulls config modules the vitest resolver cannot follow.
vi.mock("./ink.js", () => {
  function Box(_props: { readonly children?: unknown }) {
    return null;
  }
  function Text(_props: { readonly children?: unknown }) {
    return null;
  }
  return { Box, Text };
});

import {
  BashOutputView,
  execStateLine,
  parsePlainExecResult,
} from "./tool-rendering.js";
import { ResultLine } from "./components/v2/primitives.js";
import { pickToolResultDispatch } from "./tool-result-routing.js";

function resultLine(node: unknown): { readonly text: unknown; readonly failed?: boolean } {
  const element = node as {
    readonly type: unknown;
    readonly props: { readonly children?: unknown; readonly failed?: boolean };
  };
  expect(element.type).toBe(ResultLine);
  return { text: element.props.children, failed: element.props.failed };
}

function texts(node: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "string") {
      out.push(value);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const element = value as { props?: { children?: unknown } };
    if (element.props && "children" in element.props) visit(element.props.children);
  };
  visit(node);
  return out;
}

const YIELDED = "\n[exec yielded=true wall_time=1.0030s tokens=0 session_id=1]";

describe("exec footer: the model's metadata never reaches the screen", () => {
  test("a command still running shows 'still running' with its time, not the footer", () => {
    const line = resultLine(BashOutputView({ content: YIELDED }));
    expect(line.text).toBe("still running · 1s");
    expect(line.failed).toBeUndefined();
    expect(texts(BashOutputView({ content: YIELDED, verbose: true }))).toEqual(["  └  ", "still running · 1s"]);
  });

  test("a still-running command that printed something keeps its output summary first", () => {
    const content = `booting\n${YIELDED}`;
    expect(resultLine(BashOutputView({ content })).text).toBe("booting · still running · 1s");
    const all = texts(BashOutputView({ content, verbose: true }));
    expect(all).toContain("booting");
    expect(all).toContain("still running · 1s");
    expect(all.some((text) => text.includes("[exec"))).toBe(false);
  });

  test("a finished command shows its output, and 'no output' when it printed nothing", () => {
    expect(resultLine(BashOutputView({ content: "done\n\n[exec exit_code=0 wall_time=4.0100s tokens=1]" })).text).toBe("done");
    expect(resultLine(BashOutputView({ content: "\n[exec exit_code=0 wall_time=0.0100s tokens=0]" })).text).toBe("no output");
  });

  test("timeouts, signals and background services are said in words", () => {
    expect(resultLine(BashOutputView({ content: "\n[exec timed_out=true wall_time=30.0000s tokens=0]" }))).toEqual({
      text: "timed out after 30s",
      failed: true,
    });
    expect(resultLine(BashOutputView({ content: "\n[exec signal_terminated=true wall_time=2.0000s tokens=0]" }))).toEqual({
      text: "stopped by a signal",
      failed: true,
    });
    expect(resultLine(BashOutputView({ content: "listening\n\n[exec running=true pid=4242 wall_time=1.0000s tokens=2 detached=true log=/tmp/x.log]" })).text)
      .toBe("listening · running in the background");
  });

  test("notes the runtime adds after the footer stay out of the one-line form", () => {
    const content = "ok\n\n[exec exit_code=0 wall_time=0.5000s tokens=1]\nNote for the model: leftover processes were stopped.";
    const parsed = parsePlainExecResult(content);
    expect(parsed.stdout).toBe("ok");
    expect(parsed.notes).toBe("Note for the model: leftover processes were stopped.");
    expect(resultLine(BashOutputView({ content })).text).toBe("ok");
  });

  test("the state reader only reports commands that did not simply finish", () => {
    expect(execStateLine(parsePlainExecResult("x\n\n[exec exit_code=0 wall_time=1.0000s tokens=1]").state)).toBeUndefined();
    expect(execStateLine(parsePlainExecResult("x").state)).toBeUndefined();
    expect(execStateLine(parsePlainExecResult("\n[exec yielded=true wall_time=125.4000s tokens=0 session_id=3]").state))
      .toEqual({ text: "still running · 2m05s", failed: false });
  });
});

describe("exec footer routing", () => {
  test("every exec footer routes exec_command and write_stdin results to the shell view", () => {
    expect(pickToolResultDispatch("exec_command", YIELDED)).toBe("bash-output-view");
    expect(pickToolResultDispatch("write_stdin", YIELDED)).toBe("bash-output-view");
    expect(pickToolResultDispatch("write_stdin", "pong\n\n[exec exit_code=0 wall_time=0.1000s tokens=1]")).toBe("bash-output-view");
    expect(pickToolResultDispatch("exec_command", "aborted by user\n\n[exec wall_time=3.0s aborted=true]")).toBe("bash-output-view");
  });

  test("a result without an exec footer keeps its old route", () => {
    expect(pickToolResultDispatch("write_stdin", "plain text")).toBe("generic");
  });
});
