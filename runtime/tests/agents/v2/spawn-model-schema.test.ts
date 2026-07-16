import { describe, expect, it } from "vitest";
import { createSpawnAgentTool } from "./spawn.js";
import type { MultiAgentV2Options } from "./common.js";
import type { Session } from "../../session/session.js";
import { createAgentRoleWorkspace } from "../role.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/repo");

interface FakeSchema {
  readonly type: string;
  readonly properties: Record<string, Record<string, unknown>>;
}

function makeOptions(opts: {
  readonly currentSlug?: string;
  readonly listedSlugs?: readonly string[] | undefined;
}): MultiAgentV2Options {
  const session = {
    modelInfo: { slug: opts.currentSlug ?? "grok-4" },
    services: {
      modelsManager: {
        tryListModels: () =>
          opts.listedSlugs === undefined
            ? undefined
            : opts.listedSlugs.map((slug) => ({ slug })),
        listModels: async () => [],
        getModelInfo: async () => ({ slug: opts.currentSlug ?? "grok-4" }),
      },
    },
  } as unknown as Session;
  return {
    getSession: () => session,
    workspace: ROLE_WORKSPACE,
    ensureAgentControl: () => {
      throw new Error("not used in schema test");
    },
  } as unknown as MultiAgentV2Options;
}

function modelSchema(opts: MultiAgentV2Options): Record<string, unknown> {
  const tool = createSpawnAgentTool(opts);
  const schema = tool.inputSchema as unknown as FakeSchema;
  return schema.properties.model;
}

describe("spawn_agent model schema", () => {
  it("exposes the active provider's slugs as an enum, not a bare string", () => {
    const model = modelSchema(
      makeOptions({
        currentSlug: "grok-4",
        listedSlugs: ["grok-4", "grok-4-fast", "grok-3-mini"],
      }),
    );
    expect(model.type).toBe("string");
    expect(model.enum).toEqual(["grok-4", "grok-4-fast", "grok-3-mini"]);
    // Bare string schema would have no enum.
    expect(Array.isArray(model.enum)).toBe(true);
  });

  it("warns against cross-provider aliases and lists provider slugs in the description", () => {
    const model = modelSchema(
      makeOptions({
        currentSlug: "grok-4",
        listedSlugs: ["grok-4", "grok-4-fast"],
      }),
    );
    const description = String(model.description);
    expect(description).toMatch(/sonnet\/opus\/haiku/i);
    expect(description).toContain("grok-4-fast");
    // Inherit-by-default guidance references the parent's current model.
    expect(description).toContain("grok-4");
    expect(description.toLowerCase()).toContain("inherit");
  });

  it("falls back to a described string when the provider list is unavailable", () => {
    const model = modelSchema(
      makeOptions({ currentSlug: "grok-4", listedSlugs: undefined }),
    );
    expect(model.type).toBe("string");
    expect(model.enum).toBeUndefined();
    expect(String(model.description)).toMatch(/sonnet\/opus\/haiku/i);
  });
});
