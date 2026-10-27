import { describe, expect, test } from "vitest";
import { ResponsesFunctionCallItemIds } from "../../../src/llm/wire/responses-function-call-ids.js";

const call = (callId: string, id: string) => ({
  type: "function_call",
  id,
  call_id: callId,
  name: "exec_command",
  arguments: "{}",
});

describe("ResponsesFunctionCallItemIds", () => {
  test("remembers the item id a provider issued for a call id", () => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.remember("openai", call("call_a", "fc_issued_a"));

    expect(ids.get("openai", "call_a")).toBe("fc_issued_a");
    expect(ids.get("openai", "call_b")).toBeUndefined();
    expect(ids.lookupFor("openai")("call_a")).toBe("fc_issued_a");
  });

  test("keeps providers apart and matches provider names case-insensitively after trim", () => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.remember(" OpenAI ", call("call_a", "fc_issued_a"));

    expect(ids.get("openai", "call_a")).toBe("fc_issued_a");
    expect(ids.get(" openai", "call_a")).toBe("fc_issued_a");
    expect(ids.get("openai-compatible", "call_a")).toBeUndefined();
  });

  test.each([
    ["a reasoning item", { type: "reasoning", id: "rs_1", call_id: "call_a" }],
    ["a call without an item id", { type: "function_call", call_id: "call_a" }],
    ["an empty item id", call("call_a", "")],
    ["an item id with whitespace", call("call_a", "fc_ 1")],
    ["an item id with a control character", call("call_a", "fc_\u00071")],
    ["an overlong item id", call("call_a", `fc_${"x".repeat(600)}`)],
    ["a non-object", "fc_1"],
    ["null", null],
    ["an array", [call("call_a", "fc_a")]],
    ["an empty call id", { type: "function_call", id: "fc_observed", call_id: "" }],
    ["a whitespace call id", { type: "function_call", id: "fc_observed", call_id: "  " }],
    ["a control-character call id", { type: "function_call", id: "fc_observed", call_id: "call_\u00071" }],
    ["an overlong call id", { type: "function_call", id: "fc_observed", call_id: `call_${"x".repeat(600)}` }],
    ["a non-string call id", { type: "function_call", id: "fc_observed", call_id: 12 }],
  ])("ignores %s", (_label, item) => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.remember("openai", item);

    expect(ids.size).toBe(0);
    expect(ids.get("openai", "fc_observed")).toBeUndefined();
    expect(ids.get("openai", "call_a")).toBeUndefined();
  });

  test("uses an observed item id as the call token when call_id was omitted", () => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.remember("openai", { type: "function_call", id: "fc_observed" });
    expect(ids.get("openai", "fc_observed")).toBe("fc_observed");
  });

  test("records every function call of an output array and nothing else", () => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.rememberAll("openai", [
      { type: "reasoning", id: "rs_1", summary: [] },
      call("call_a", "fc_a"),
      { type: "message", id: "msg_1", content: [] },
      call("call_b", "fc_b"),
    ]);
    ids.rememberAll("openai", undefined);

    expect(ids.size).toBe(2);
    expect(ids.get("openai", "call_b")).toBe("fc_b");
  });

  test("forgets the oldest calls beyond its capacity and refreshes a call seen again", () => {
    const ids = new ResponsesFunctionCallItemIds(2);
    ids.remember("openai", call("call_a", "fc_a"));
    ids.remember("openai", call("call_b", "fc_b"));
    ids.remember("openai", call("call_a", "fc_a2"));
    ids.remember("openai", call("call_c", "fc_c"));

    expect(ids.size).toBe(2);
    expect(ids.get("openai", "call_b")).toBeUndefined();
    expect(ids.get("openai", "call_a")).toBe("fc_a2");
    expect(ids.get("openai", "call_c")).toBe("fc_c");
  });

  test.each([0, -3])("keeps one newest call when capacity is %s", (capacity) => {
    const ids = new ResponsesFunctionCallItemIds(capacity);
    ids.remember("openai", call("call_a", "fc_a"));
    ids.remember("openai", call("call_b", "fc_b"));

    expect(ids.size).toBe(1);
    expect(ids.get("openai", "call_a")).toBeUndefined();
    expect(ids.get("openai", "call_b")).toBe("fc_b");
  });

  test("clears every remembered call", () => {
    const ids = new ResponsesFunctionCallItemIds();
    ids.remember("openai", call("call_a", "fc_a"));
    ids.clear();

    expect(ids.size).toBe(0);
    expect(ids.get("openai", "call_a")).toBeUndefined();
  });
});
