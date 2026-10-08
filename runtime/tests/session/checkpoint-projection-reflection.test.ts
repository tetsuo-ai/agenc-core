import { describe, expect, it, vi } from "vitest";
import type { LLMMessage } from "../../src/llm/types.js";
import { withCheckpointProjectionCache } from "../../src/session/checkpoint-projection-cache.js";
import { llmMessageToCheckpointResponseItem } from "../../src/session/message-history-conversion.js";
import { serializeRolloutItem } from "../../src/session/rollout-item.js";
import { createToolResultIntegrity } from "../../src/session/tool-result-integrity.js";

type Value = Record<string | symbol, unknown>;
type Path = readonly string[];
const seal = ["runtimeOnly", "toolResultIntegrity"];
const objectPaths: Path[] = [[], ["runtimeOnly"], seal, [...seal, "original"], [...seal, "persisted"]];
function makeTool(): LLMMessage {
  const content = "ordinary echo output";
  return { role: "tool", content, toolCallId: "call-one", toolName: "exec_command",
    runtimeOnly: { toolResultIntegrity: createToolResultIntegrity({
      runId: "test-run", toolCallId: "call-one", content,
    }) } };
}
function objectAt(message: LLMMessage, path: Path): Value {
  let value: unknown = message;
  for (const key of path) value = (value as Value)[key];
  return value as Value;
}
type Decoration = (message: LLMMessage, trace: string[]) => {
  message: LLMMessage;
  restore?: () => void;
};

/** Compare separately constructed inputs so the first projection cannot alter
 * the second input's traps, getter state or callback counts. */
function compareFallback(decorate: Decoration): void {
  const run = (cached: boolean) => {
    const message = makeTool();
    const full = vi.fn(llmMessageToCheckpointResponseItem);
    const project = cached ? withCheckpointProjectionCache(full) : full;
    if (cached) {
      project(message);
      project(message);
      expect(full).toHaveBeenCalledTimes(1);
      full.mockClear();
    }
    const trace: string[] = [];
    const decorated = decorate(message, trace);
    try {
      let outcome: unknown;
      try {
        const response = project(decorated.message);
        outcome = serializeRolloutItem({ type: "response_item", payload: response });
      } catch (error) {
        outcome = error instanceof Error ? [error.name, error.message] : String(error);
      }
      expect(full).toHaveBeenCalledTimes(1);
      return { outcome, trace };
    } finally {
      decorated.restore?.();
    }
  };
  expect(run(true)).toEqual(run(false));
}

describe("checkpoint eligibility preserves fallback reflection behavior", () => {
  it.each([
    [[], "content"], [["runtimeOnly"], "toolResultIntegrity"],
    [seal, "original"], [[...seal, "original"], "digest"],
    [[...seal, "persisted"], "digest"],
  ] as Array<[Path, string]>)("does not invoke an accessor during eligibility: %j.%s", (path, key) => {
    compareFallback((message, trace) => {
      const object = objectAt(message, path);
      const value = object[key];
      Object.defineProperty(object, key, { enumerable: true, configurable: true,
        get() { trace.push(`get:${key}`); return value; } });
      return { message };
    });
  });

  it.each(objectPaths.map((path) => [path.join(".") || "message", path] as const))(
    "adds no proxy traps for %s", (_name, path) => {
      compareFallback((message, trace) => {
        const proxy = new Proxy(objectAt(message, path), {
          get(target, key, receiver) { trace.push(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
          getPrototypeOf(target) { trace.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
          getOwnPropertyDescriptor(target, key) { trace.push(`descriptor:${String(key)}`); return Reflect.getOwnPropertyDescriptor(target, key); },
          ownKeys(target) { trace.push("ownKeys"); return Reflect.ownKeys(target); },
          has(target, key) { trace.push(`has:${String(key)}`); return Reflect.has(target, key); },
        });
        if (path.length === 0) return { message: proxy as unknown as LLMMessage };
        objectAt(message, path.slice(0, -1))[path.at(-1)!] = proxy;
        return { message };
      });
    },
  );

  it("preserves revoked-proxy failures without reflecting on the proxy", () => {
    compareFallback((message) => {
      const { proxy, revoke } = Proxy.revocable(message, {});
      revoke();
      return { message: proxy };
    });
  });

  it.each(objectPaths.map((path) => [path.join(".") || "message", path] as const))(
    "does not invoke a toJSON getter before fallback for %s", (_name, path) => {
      compareFallback((message, trace) => {
        Object.defineProperty(objectAt(message, path), "toJSON", {
          configurable: true,
          get() { trace.push("get:toJSON"); return undefined; },
        });
        return { message };
      });
    },
  );

  const excluded: Array<[Path, string, unknown]> = [
    [[], "toolCalls", []],
    [[], "providerReasoningContent", "ordinary replay"],
    [[], "providerReasoningProvenance", { provider: "test", model: "test-model" }],
    [["runtimeOnly"], "agentInvocation", undefined],
    [["runtimeOnly"], "compactionHistory", undefined],
  ];
  it.each(excluded)("falls back for inherited excluded field %j.%s", (path, key, value) => {
    // An Object.prototype property exercises the absent-read check even when
    // the immediate prototype is the admitted Object.prototype itself.
    compareFallback((message, trace) => {
      const target = objectAt(message, path);
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
      Object.defineProperty(Object.prototype, key, { configurable: true,
        get() {
          if (this === target) { trace.push(`inherited:${key}`); return value; }
          return undefined;
        } });
      return { message, restore() {
        if (previous === undefined) Reflect.deleteProperty(Object.prototype, key);
        else Object.defineProperty(Object.prototype, key, previous);
      } };
    });
  });

  it("falls back for inherited toJSON without an additional hook invocation", () => {
    compareFallback((message, trace) => {
      const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
      Object.defineProperty(Object.prototype, "toJSON", { configurable: true,
        get() { if (this === message) trace.push("inherited:toJSON"); return undefined; } });
      return { message, restore() {
        if (previous === undefined) Reflect.deleteProperty(Object.prototype, "toJSON");
        else Object.defineProperty(Object.prototype, "toJSON", previous);
      } };
    });
  });

  it.each(excluded)("rejects present-undefined excluded field %j.%s", (path, key) => {
    compareFallback((message) => {
      objectAt(message, path)[key] = undefined;
      return { message };
    });
  });

  it.each(objectPaths.map((path) => [path.join(".") || "message", path] as const))(
    "keeps symbols, unknown properties and custom prototypes in %s on the full path", (_name, path) => {
      for (const change of ["symbol", "unknown", "prototype"] as const) {
        compareFallback((message) => {
          const object = objectAt(message, path);
          if (change === "symbol") object[Symbol("additional field")] = "extra";
          else if (change === "unknown") object.extra = "extra";
          else Object.setPrototypeOf(object, { extra: "inherited extra" });
          return { message };
        });
      }
    },
  );

  it("accepts null prototypes and ignores source writable/configurable flags", () => {
    const message = makeTool();
    for (const path of objectPaths) Object.setPrototypeOf(objectAt(message, path), null);
    const full = vi.fn(llmMessageToCheckpointResponseItem);
    const project = withCheckpointProjectionCache(full);
    const first = project(message);
    for (const path of objectPaths) Object.freeze(objectAt(message, path));
    const second = project(message);
    expect(full).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(JSON.stringify(second)).toBe(JSON.stringify(llmMessageToCheckpointResponseItem(message)));
  });
});
