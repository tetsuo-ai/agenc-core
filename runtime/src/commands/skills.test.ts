import { describe, expect, it } from "vitest";

import skillsCommand, {
  collectSkillsSnapshot,
  formatSkillsSnapshot,
} from "./skills.js";
import type { Session } from "../session/session.js";

function stubSession(opts: {
  invokedSkills?: readonly string[];
  roots?: unknown;
}): Session {
  return {
    config: { model: "test" },
    services: {
      skillsManager: {
        skillsForConfig: async () => ({
          invokedSkills: opts.invokedSkills ?? [],
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
  it("collects sorted invoked skills and plugin roots", async () => {
    const snapshot = await collectSkillsSnapshot(
      stubSession({
        invokedSkills: ["zeta", "alpha"],
        roots: new Set(["/z", "/a"]),
      }),
    );
    expect(snapshot).toEqual({
      invokedSkills: ["alpha", "zeta"],
      effectiveSkillRoots: ["/a", "/z"],
    });
  });

  it("formats empty state explicitly", () => {
    expect(
      formatSkillsSnapshot({ invokedSkills: [], effectiveSkillRoots: [] }),
    ).toBe("Skills:\n  loaded: none\n  plugin roots: none");
  });

  it("executes /skills list", async () => {
    const result = await skillsCommand.execute({
      session: stubSession({ invokedSkills: ["debug"], roots: ["/skills"] }),
      argsRaw: "list",
      cwd: "/tmp/ws",
      home: "/home/test",
    });

    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("loaded: debug");
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
