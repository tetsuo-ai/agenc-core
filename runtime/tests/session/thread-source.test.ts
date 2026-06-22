import { describe, expect, it } from "vitest";
import {
  agentIdFromThreadSource,
  agentIdFromThreadSourceJson,
  isAgentThreadSource,
  threadSourceStringField,
} from "../thread-store/thread-source.js";

describe("thread source metadata helpers", () => {
  it("handles null-prototype records without accepting arrays or null", () => {
    const source = Object.assign(Object.create(null), {
      agentId: "agent-null-prototype",
    });
    expect(agentIdFromThreadSource(source)).toBe("agent-null-prototype");
    expect(agentIdFromThreadSource({ source: [] })).toBe(undefined);
    expect(agentIdFromThreadSourceJson(JSON.stringify([]))).toBe(undefined);
    expect(threadSourceStringField(undefined, "agentId")).toBe(undefined);
    expect(threadSourceStringField("agent", "agentId")).toBe(undefined);
  });

  it("reads non-empty string fields from structured sources", () => {
    expect(threadSourceStringField({ objective: "build" }, "objective")).toBe(
      "build",
    );
    expect(threadSourceStringField({ objective: "" }, "objective")).toBe(
      undefined,
    );
    expect(threadSourceStringField({ objective: 1 }, "objective")).toBe(
      undefined,
    );
  });

  it("extracts agent ids from direct and nested structured sources", () => {
    expect(
      agentIdFromThreadSource({
        agentId: "agent-direct",
        agent_id: "agent-legacy",
      }),
    ).toBe("agent-direct");
    expect(agentIdFromThreadSource({ agent_id: "agent-legacy" })).toBe(
      "agent-legacy",
    );
    expect(
      agentIdFromThreadSource({
        source: { agentId: "agent-nested" },
      }),
    ).toBe("agent-nested");
    expect(
      agentIdFromThreadSource({
        source: { agent_id: "agent-nested-legacy" },
      }),
    ).toBe("agent-nested-legacy");
    expect(
      agentIdFromThreadSource({
        source: { parentThreadId: "parent-thread" },
      }),
    ).toBe("parent-thread");
  });

  it("ignores source labels and malformed agent id fields", () => {
    expect(agentIdFromThreadSource("agent")).toBe(undefined);
    expect(agentIdFromThreadSource("agent_thread")).toBe(undefined);
    expect(agentIdFromThreadSource("cli_main")).toBe(undefined);
    expect(agentIdFromThreadSource({ agentId: "" })).toBe(undefined);
    expect(agentIdFromThreadSource({ agentId: 1 })).toBe(undefined);
    expect(agentIdFromThreadSource({ source: [] })).toBe(undefined);
  });

  it("extracts agent ids from persisted source JSON", () => {
    expect(
      agentIdFromThreadSourceJson(JSON.stringify({ agent_id: "agent-json" })),
    ).toBe("agent-json");
    expect(
      agentIdFromThreadSourceJson(
        JSON.stringify({ source: { parentThreadId: "parent-json" } }),
      ),
    ).toBe("parent-json");
    expect(agentIdFromThreadSourceJson(null)).toBe(undefined);
    expect(agentIdFromThreadSourceJson("{")).toBe(undefined);
    expect(agentIdFromThreadSourceJson(JSON.stringify("agent"))).toBe(
      undefined,
    );
    expect(agentIdFromThreadSourceJson(JSON.stringify([]))).toBe(undefined);
  });

  it("detects agent thread sources without broadening nested source kinds", () => {
    expect(isAgentThreadSource("agent")).toBe(true);
    expect(isAgentThreadSource("agent_thread")).toBe(true);
    expect(isAgentThreadSource("cli_main")).toBe(false);
    expect(isAgentThreadSource(undefined)).toBe(false);
    expect(isAgentThreadSource({ kind: "agent" })).toBe(true);
    expect(isAgentThreadSource({ kind: "agent_thread" })).toBe(true);
    expect(isAgentThreadSource({ kind: "thread_spawn" })).toBe(true);
    expect(isAgentThreadSource({ source: { kind: "thread_spawn" } })).toBe(
      true,
    );
    expect(isAgentThreadSource({ source: { kind: "agent" } })).toBe(false);
  });
});
