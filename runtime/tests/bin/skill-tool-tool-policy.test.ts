import { describe, expect, it } from "vitest";

// Loading a bundled skill resolves the build-time MACRO define. Stub before
// the dynamic imports below.
(globalThis as Record<string, unknown>).MACRO = {
  VERSION: "99.0.0",
  DISPLAY_VERSION: "0.0.0-test",
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER:
    "report the issue at https://github.com/tetsuo-ai/agenc-core/issues",
  PACKAGE_URL: "@tetsuo-ai/agenc",
  NATIVE_PACKAGE_URL: undefined,
};

import type { SessionToolPolicy } from "../permissions/session-tool-policy.js";
import { normalizeSessionToolPolicy } from "../permissions/session-tool-policy.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
import type { Session } from "../session/session.js";

const INSTALLER = "agenc-marketplace-kit-installer";

function session(config: unknown = {}): Session {
  return {
    conversationId: "conv-tool-policy-skill",
    config,
    services: {
      skillsManager: {
        renderSkill: async () => null,
        resolveSkill: async () => null,
        skillsForConfig: async () => ({
          invokedSkills: [],
          availableSkills: [{ name: "local-only" }],
        }),
      },
      configStore: { current: () => config },
    },
  } as unknown as Session;
}

async function skillTool(opts: {
  readonly policy?: SessionToolPolicy;
  readonly config?: unknown;
}) {
  const { createModelFacingTools } = await import("./model-facing-tools.js");
  const current = session(opts.config ?? {});
  const tool = createModelFacingTools({
    workspaceRoot: process.cwd(),
    getSession: () => current,
    ...(opts.policy !== undefined ? { toolPolicy: opts.policy } : {}),
  }).find((candidate) => candidate.name === "Skill")!;
  return { tool, current };
}

async function permissionFor(
  tool: Awaited<ReturnType<typeof skillTool>>["tool"],
  current: Session,
  skill: string,
) {
  return tool.checkPermissions!(
    { skill },
    {
      session: current,
      getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext() }),
    } as never,
  );
}

const enabledBrowser = normalizeSessionToolPolicy({
  enabledTools: ["Skill", "Skill:browser-automation"],
});
const skillToolOnly = normalizeSessionToolPolicy({ enabledTools: ["Skill"] });

describe("Skill tool in a session with a toolPolicy", () => {
  it("refuses a bundled skill the policy does not enable, without loading it", async () => {
    const { tool } = await skillTool({ policy: skillToolOnly });

    const result = await tool.execute({ skill: "browser-automation" });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content) as { error: string };
    expect(payload.error).toBe('skill "browser-automation" is not enabled for this session');
    expect(result.content).not.toContain("<command-name>");
  });

  it("loads a bundled skill the policy names", async () => {
    const { tool } = await skillTool({ policy: enabledBrowser });

    const result = await tool.execute({ skill: "browser-automation" });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("<command-name>browser-automation</command-name>");
  });

  it("enables only the skills it names", async () => {
    const { tool } = await skillTool({ policy: enabledBrowser });

    const result = await tool.execute({ skill: INSTALLER });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("curl");
    expect(result.content).not.toContain("<command-name>");
  });

  it("never loads the kit installer, even for a policy that names it", async () => {
    // A validated policy cannot name it; a hand-built one must still not work.
    const forced = {
      enabledTools: ["Skill", `Skill:${INSTALLER}`],
    } as SessionToolPolicy;
    const { tool } = await skillTool({ policy: forced });

    const result = await tool.execute({ skill: INSTALLER });

    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("curl");
    expect(result.content).not.toContain("install.sh");
    expect(result.content).not.toContain("agenc install");
  });

  it("does not name withheld bundled skills in an unknown-skill refusal", async () => {
    const { tool } = await skillTool({ policy: enabledBrowser });

    const result = await tool.execute({ skill: "no-such-skill" });

    const payload = JSON.parse(result.content) as { available: string[] };
    expect(payload.available).toContain("browser-automation");
    expect(payload.available).toContain("local-only");
    expect(payload.available).not.toContain(INSTALLER);

    const none = await skillTool({ policy: skillToolOnly });
    const bare = JSON.parse((await none.tool.execute({ skill: "no-such-skill" })).content) as {
      available: string[];
    };
    expect(bare.available).toEqual(["local-only"]);
  });

  it("denies the permission check for a withheld bundled skill and allows an enabled one", async () => {
    const withheld = await skillTool({ policy: skillToolOnly });
    const denied = await permissionFor(withheld.tool, withheld.current, "browser-automation");
    expect(denied.behavior).toBe("deny");

    const installer = await skillTool({ policy: enabledBrowser });
    expect((await permissionFor(installer.tool, installer.current, INSTALLER)).behavior).toBe("deny");

    const enabled = await skillTool({ policy: enabledBrowser });
    expect((await permissionFor(enabled.tool, enabled.current, "browser-automation")).behavior)
      .toBe("allow");
  });
});

describe("Skill tool without a toolPolicy", () => {
  it("still loads the kit installer when asked for by exact name", async () => {
    const { tool } = await skillTool({});

    const result = await tool.execute({ skill: INSTALLER });

    expect(result.isError).toBeUndefined();
    expect(result.content).toContain(`<command-name>${INSTALLER}</command-name>`);
  });

  it("does not offer the kit installer in an unknown-skill refusal by default", async () => {
    const { tool } = await skillTool({});

    const payload = JSON.parse((await tool.execute({ skill: "no-such-skill" })).content) as {
      available: string[];
    };

    expect(payload.available).toContain("browser-automation");
    expect(payload.available).not.toContain(INSTALLER);
  });

  it("offers the kit installer once the operator enabled the marketplace", async () => {
    const { tool } = await skillTool({
      config: { protocol: { enabled: true, adapter: "marketplace-cli" } },
    });

    const payload = JSON.parse((await tool.execute({ skill: "no-such-skill" })).content) as {
      available: string[];
    };

    expect(payload.available).toContain(INSTALLER);
  });
});
