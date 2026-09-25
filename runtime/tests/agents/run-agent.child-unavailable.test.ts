/**
 * A sub-agent never offers or runs a tool its parent marks unavailable.
 *
 * `buildFilteredRegistry` built the child's wrappers from `base.tools`, which
 * keeps unavailable tools for telemetry. When the parent's model catalog is
 * empty, the child falls back to advertising every wrapper, so the child's
 * dispatch reached the parent tool's `execute` and skipped the refusal and
 * its confirmed_no_effect result.
 */
import { describe, expect, test, vi } from "vitest";
import {
  buildFilteredRegistry,
  TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
} from "../../src/agents/run-agent.js";
import type { ToolRegistry } from "../../src/tool-registry.js";

describe("child registries and unavailable parent tools", () => {
  test("an empty parent catalog does not let a child offer or run an unavailable tool", async () => {
    const unavailableExecute = vi.fn(async () => ({ content: "unavailable tool ran" }));
    const availableExecute = vi.fn(async () => ({ content: "available tool ran" }));
    const parent: ToolRegistry = {
      tools: [
        {
          name: "Probe",
          description: "kept by the parent for telemetry only",
          inputSchema: { type: "object" },
          execute: unavailableExecute,
        },
        {
          name: "Other",
          description: "an ordinary parent tool",
          inputSchema: { type: "object" },
          execute: availableExecute,
        },
      ],
      // Empty model catalog: the child falls back to its own wrappers.
      toLLMTools: () => [],
      dispatch: async () => ({ content: "parent dispatch must not run" }),
      getUnavailableToolNames: () => new Set(["Probe"]),
    };
    const child = buildFilteredRegistry(parent, {
      childConversationId: "child-unavailable",
      unadmittedDispatchOverride: TEST_ONLY_ALLOW_UNADMITTED_CHILD_REGISTRY_DISPATCH,
    });

    const refused = await child.dispatch({ id: "c1", name: "Probe", arguments: "{}" });
    expect(unavailableExecute).not.toHaveBeenCalled();
    expect(refused).toMatchObject({
      isError: true,
      content:
        "<tool_use_error>Error: Probe is unavailable in this session and cannot be called.</tool_use_error>",
      effectDisposition: {
        disposition: "confirmed_no_effect",
        evidenceKind: "boundary_not_crossed",
        evidenceRef: "tool:Probe:unavailable",
      },
    });
    expect(child.tools.map((tool) => tool.name)).toEqual(["Other"]);
    expect(child.toLLMTools().map((tool) => tool.function.name)).toEqual(["Other"]);
    // Nested children see the same set, so the refusal holds at any depth.
    expect([...(child.getUnavailableToolNames?.() ?? [])]).toEqual(["Probe"]);

    // The fallback still serves the tools that are available.
    const ran = await child.dispatch({ id: "c2", name: "Other", arguments: "{}" });
    expect(availableExecute).toHaveBeenCalledOnce();
    expect(ran.isError).not.toBe(true);
  });
});
