import { describe, expect, it } from "vitest";

import skillsCommand, {
  collectSkillsSnapshot,
  formatSkillsSnapshot,
} from "./skills.js";
import type { Session } from "../session/session.js";

function stubSession(opts: {
  invokedSkills?: readonly string[];
  availableSkills?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly scope?: string;
    readonly loadedFrom?: string;
  }>;
  roots?: unknown;
}): Session {
  return {
    config: { model: "test" },
    services: {
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: opts.invokedSkills ?? [],
          availableSkills: opts.availableSkills ?? [],
        }),
      },
      pluginsManager: {
        pluginsForConfig: async () => ({
          effectiveSkillRoots: () => opts.roots ?? [],
        }),
      },
    },
  } as unknown as Session;
}

describe("skillsCommand", () => {
  it("collects sorted available skills, invoked skills, and plugin roots", async () => {
    const snapshot = await collectSkillsSnapshot(
      stubSession({
        invokedSkills: ["zeta", "alpha"],
        availableSkills: [{ name: "zeta" }, { name: "alpha" }],
        roots: new Set(["/z", "/a"]),
      }),
    );
    expect(snapshot).toEqual({
      invokedSkills: ["alpha", "zeta"],
      availableSkills: [
        {
          name: "alpha",
          description: undefined,
          scope: undefined,
          loadedFrom: undefined,
          userInvocable: undefined,
          disableModelInvocation: undefined,
        },
        {
          name: "zeta",
          description: undefined,
          scope: undefined,
          loadedFrom: undefined,
          userInvocable: undefined,
          disableModelInvocation: undefined,
        },
      ],
      effectiveSkillRoots: ["/a", "/z"],
    });
  });

  it("formats empty state explicitly", () => {
    expect(
      formatSkillsSnapshot({
        invokedSkills: [],
        availableSkills: [],
        effectiveSkillRoots: [],
      }),
    ).toBe("Skills:\n  available: none\n  invoked: none\n  plugin roots: none");
  });

  it("executes /skills list", async () => {
    const result = await skillsCommand.execute({
      session: stubSession({
        invokedSkills: ["debug"],
        availableSkills: [{ name: "debug" }],
        roots: ["/skills"],
      }),
      argsRaw: "list",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("available: debug");
      expect(result.text).toContain("invoked: debug");
      expect(result.text).toContain("plugin roots: /skills");
    }
  });

  it("rejects unsupported subcommands", async () => {
    const result = await skillsCommand.execute({
      session: stubSession({}),
      argsRaw: "install",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("error");
  });
});
