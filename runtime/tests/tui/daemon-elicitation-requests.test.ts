import { describe, expect, it } from "vitest";

import { DaemonElicitationRequests } from "../../src/tui/daemon-elicitation-requests.js";

const form = { kind: "mcp", serverName: "profile", requestId: 7 } as const;
const question = { kind: "request_user_input", requestId: "call-1" } as const;

describe("DaemonElicitationRequests", () => {
  it("closes the prompt at the address and turn the daemon names", () => {
    const requests = new DaemonElicitationRequests();
    const formPrompt = requests.begin(form, "turn-1")!;
    const questionPrompt = requests.begin(question, "turn-1")!;

    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-1" }),
    ).toBe(true);
    expect(formPrompt.signal.aborted).toBe(true);
    expect(questionPrompt.signal.aborted).toBe(false);

    expect(
      requests.close({ kind: "request_user_input", requestId: "call-1", turnId: "turn-1" }),
    ).toBe(true);
    expect(questionPrompt.signal.aborted).toBe(true);
  });

  it("ignores a close for another server, another turn, or an unknown request", () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin(form, "turn-2")!;

    expect(
      requests.close({ kind: "mcp", serverName: "other", requestId: 7, turnId: "turn-2" }),
    ).toBe(false);
    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-1" }),
    ).toBe(false);
    expect(
      requests.close({ kind: "request_user_input", requestId: "7", turnId: "turn-2" }),
    ).toBe(false);
    expect(requests.close({ kind: "mcp", requestId: 7 })).toBe(false);
    expect(prompt.signal.aborted).toBe(false);
  });

  it("shows one prompt for a request delivered twice", () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin(form, "turn-1")!;

    expect(requests.begin(form, "turn-1")).toBeUndefined();
    requests.finish(form, prompt);
    expect(requests.begin(form, "turn-1")).toBeDefined();
  });

  it("replaces a prompt when another turn reuses its address", () => {
    const requests = new DaemonElicitationRequests();
    const older = requests.begin(form, "turn-1")!;
    const newer = requests.begin(form, "turn-2")!;

    expect(older.signal.aborted).toBe(true);
    expect(newer.signal.aborted).toBe(false);
    // The older prompt settling later must not forget the newer one.
    requests.finish(form, older);
    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-2" }),
    ).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  it("closes every prompt when the event stream ends", () => {
    const requests = new DaemonElicitationRequests();
    const formPrompt = requests.begin(form, "turn-1")!;
    const questionPrompt = requests.begin(question, undefined)!;

    requests.closeAll();

    expect(formPrompt.signal.aborted).toBe(true);
    expect(questionPrompt.signal.aborted).toBe(true);
    expect(requests.begin(form, "turn-3")).toBeUndefined();
  });
});
