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
    const prompt = requests.begin(form, "turn-1", 10)!;

    expect(requests.begin(form, "turn-1", 10)).toBeUndefined();
    expect(requests.begin(form, "turn-1", undefined)).toBeUndefined();
    expect(prompt.signal.aborted).toBe(false);
  });

  it("keeps the newer prompt when a replaced one settles later", () => {
    const requests = new DaemonElicitationRequests();
    const older = requests.begin(form, "turn-1", 10)!;
    const newer = requests.begin(form, "turn-2", 20)!;

    requests.finish(form, older);
    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-2" }),
    ).toBe(true);
    expect(newer.signal.aborted).toBe(true);
  });

  it("never reopens a request after this client answered it", () => {
    const requests = new DaemonElicitationRequests();
    const prompt = requests.begin(form, "turn-1", 10)!;
    requests.finish(form, prompt);

    expect(requests.begin(form, "turn-1", 10)).toBeUndefined();
    expect(requests.begin(form, "turn-1", undefined)).toBeUndefined();
  });

  it("never reopens a request after the daemon closed it", () => {
    const requests = new DaemonElicitationRequests();
    requests.begin(form, "turn-1", 10);
    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-1" }),
    ).toBe(true);

    expect(requests.begin(form, "turn-1", 10)).toBeUndefined();
    // A close that arrives before its request is shown also keeps it closed.
    expect(
      requests.close({ kind: "request_user_input", requestId: "call-1", turnId: "turn-1" }),
    ).toBe(false);
    expect(requests.begin(question, "turn-1", 12)).toBeUndefined();
  });

  it("ignores an older request replayed while a newer one at the same address is open", () => {
    const requests = new DaemonElicitationRequests();
    const turn2 = requests.begin(form, "turn-2", 20)!;

    expect(requests.begin(form, "turn-1", 10)).toBeUndefined();
    expect(turn2.signal.aborted).toBe(false);
    // Still the open prompt: the daemon close for turn 2 reaches it.
    expect(
      requests.close({ kind: "mcp", serverName: "profile", requestId: 7, turnId: "turn-2" }),
    ).toBe(true);
    expect(turn2.signal.aborted).toBe(true);
  });

  it("ignores a request older than one already seen at the address, even when none is open", () => {
    const requests = new DaemonElicitationRequests();
    const turn2 = requests.begin(form, "turn-2", 20)!;
    requests.finish(form, turn2);

    expect(requests.begin(form, "turn-1", 10)).toBeUndefined();
  });

  it("lets a newer request at the same address replace the open one", () => {
    const requests = new DaemonElicitationRequests();
    const older = requests.begin(form, "turn-1", 10)!;
    const sameTurnLater = requests.begin(form, "turn-1", 15)!;

    expect(older.signal.aborted).toBe(true);
    expect(sameTurnLater.signal.aborted).toBe(false);
    const nextTurn = requests.begin(form, "turn-2", 20)!;
    expect(sameTurnLater.signal.aborted).toBe(true);
    expect(nextTurn.signal.aborted).toBe(false);
  });

  it("does not replace an open prompt when it cannot tell which request is newer", () => {
    const requests = new DaemonElicitationRequests();
    const open = requests.begin(form, "turn-2", undefined)!;

    expect(requests.begin(form, "turn-1", undefined)).toBeUndefined();
    expect(open.signal.aborted).toBe(false);
  });

  it("closes a turn's prompts when the turn ends and opens none for it later", () => {
    const requests = new DaemonElicitationRequests();
    const ending = requests.begin(form, "turn-1", 10)!;
    const other = requests.begin(question, "turn-2", 11)!;

    requests.noteTurnEnded("turn-1");

    expect(ending.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(requests.begin(form, "turn-1", 12)).toBeUndefined();
    expect(requests.begin(form, "turn-3", 30)).toBeDefined();
  });

  it("keeps a bounded record of settled requests", () => {
    const requests = new DaemonElicitationRequests(2);
    for (const requestId of ["a", "b", "c"]) {
      const address = { kind: "request_user_input", requestId } as const;
      requests.finish(address, requests.begin(address, "turn-1", undefined)!);
    }
    // The oldest record was dropped to keep the bound; the newer ones hold.
    expect(requests.begin({ kind: "request_user_input", requestId: "a" }, "turn-1", undefined))
      .toBeDefined();
    expect(requests.begin({ kind: "request_user_input", requestId: "c" }, "turn-1", undefined))
      .toBeUndefined();
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
