import { describe, expect, it } from "vitest";

import {
  isRuntimeInjectedArgKey,
  strictArgsRefusal,
} from "../../src/tools/strict-args.js";
import type { ToolResult } from "../../src/tools/types.js";

const refuse = (message: string): ToolResult => ({ content: message, isError: true });
const opts = { allowed: new Set(["name"]), required: ["name"], injected: ["__callId"] };

describe("strict tool arguments", () => {
  it("tolerates every runtime-injected key, not only the ones a caller lists", () => {
    // Soak F64: a workflow child's spawn_agent was refused seven times for
    // `__agencSessionAllowedRoots`, a key the executor injects.
    expect(
      strictArgsRefusal(
        {
          name: "scanner",
          __callId: "call-1",
          __agencSessionId: "s-1",
          __agencSessionAllowedRoots: ["/repo"],
          __agencSessionIdSig: "sig",
          __agencHome: "/home",
        },
        opts,
        refuse,
      ),
    ).toBeNull();
  });

  it("still refuses a field the model invented", () => {
    expect(strictArgsRefusal({ name: "scanner", bogus: 1 }, opts, refuse)?.content).toBe(
      "unknown field `bogus`",
    );
    expect(strictArgsRefusal({ name: "scanner", __other: 1 }, opts, refuse)?.content).toBe(
      "unknown field `__other`",
    );
  });

  it("enforces required strings, blank or not, as asked", () => {
    expect(strictArgsRefusal({}, opts, refuse)?.content).toBe("name is required");
    expect(strictArgsRefusal({ name: "  " }, opts, refuse)?.content).toBe("name is required");
    expect(strictArgsRefusal({ name: "  " }, { ...opts, allowBlank: true }, refuse)).toBeNull();
  });

  it("names the injected keys by their prefix", () => {
    expect(isRuntimeInjectedArgKey("__agencSessionAllowedRoots")).toBe(true);
    expect(isRuntimeInjectedArgKey("__callId")).toBe(true);
    expect(isRuntimeInjectedArgKey("__abortSignal")).toBe(false);
    expect(isRuntimeInjectedArgKey("name")).toBe(false);
  });
});
