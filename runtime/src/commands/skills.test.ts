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
    readonly userInvocable?: boolean;
    readonly disableModelInvocation?: boolean;
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

  it("merges MCP-derived skills from AppState into the snapshot", async () => {
    const snapshot = await collectSkillsSnapshot(
      stubSession({
        availableSkills: [
          {
            name: "local-review",
            description: "Local review skill",
            loadedFrom: "skills",
          },
        ],
      }),
      {
        getAppState: () => ({
          mcp: {
            commands: [
              {
                name: "mcp__Docs_Server__reviewer",
                description: "Remote review skill",
                loadedFrom: "mcp",
                userInvocable: true,
                disableModelInvocation: false,
              },
              {
                name: "plugin-review",
                description: "Plugin command",
                loadedFrom: "plugin",
              },
              {
                name: "",
                loadedFrom: "mcp",
              },
            ],
          },
        }),
      },
    );

    expect(snapshot.availableSkills).toEqual([
      {
        name: "local-review",
        description: "Local review skill",
        scope: undefined,
        loadedFrom: "skills",
        userInvocable: undefined,
        disableModelInvocation: undefined,
      },
      {
        name: "mcp__Docs_Server__reviewer",
        description: "Remote review skill",
        scope: undefined,
        loadedFrom: "mcp",
        userInvocable: true,
        disableModelInvocation: false,
      },
    ]);
  });

  it("formats empty state explicitly", () => {
    expect(
      formatSkillsSnapshot({
        invokedSkills: [],
        availableSkills: [],
        effectiveSkillRoots: [],
      }),
    ).toBe(
      [
        "Skills:",
        "  use: $skill-name [args] (slash commands use /, file mentions use @)",
        "  available: none",
        "  invoked: none",
        "  plugin roots: none",
      ].join("\n"),
    );
  });

  it("formats skills with dollar prefixes, descriptions, and source tags", () => {
    expect(
      formatSkillsSnapshot({
        invokedSkills: ["debug"],
        availableSkills: [
          {
            name: "debug",
            description: "Debug a failing workflow",
            loadedFrom: "skills",
          },
          {
            name: "mcp__Docs_Server__reviewer",
            description: "Remote review skill",
            loadedFrom: "mcp",
          },
        ],
        effectiveSkillRoots: ["/skills"],
      }),
    ).toBe(
      [
        "Skills:",
        "  use: $skill-name [args] (slash commands use /, file mentions use @)",
        "  available: 2",
        "    $debug - Debug a failing workflow [skills]",
        "    $mcp__Docs_Server__reviewer - Remote review skill [mcp]",
        "  invoked: $debug",
        "  plugin roots: /skills",
      ].join("\n"),
    );
  });

  it("caps the default skills list and points to filtering", () => {
    const availableSkills = Array.from({ length: 14 }, (_, index) => ({
      name: `skill_${String(index).padStart(2, "0")}`,
      description: `Skill ${index} does useful work`,
      loadedFrom: "skills",
    }));

    const text = formatSkillsSnapshot({
      invokedSkills: [],
      availableSkills,
      effectiveSkillRoots: [],
    });

    expect(text).toContain("available: showing 12 of 14");
    expect(text).toContain("$skill_00 - Skill 0 does useful work [skills]");
    expect(text).not.toContain("$skill_13");
    expect(text).toContain("more: 2 hidden; use /skills all or /skills <search>");
  });

  it("filters skills by query and truncates long descriptions", () => {
    const text = formatSkillsSnapshot(
      {
        invokedSkills: [],
        availableSkills: [
          {
            name: "python-game",
            description: "Create ".repeat(40),
            loadedFrom: "skills",
          },
          {
            name: "release-notes",
            description: "Draft release notes",
            loadedFrom: "skills",
          },
        ],
        effectiveSkillRoots: [],
      },
      { query: "python" },
    );

    expect(text).toContain("filter: python");
    expect(text).toContain("available: 1");
    expect(text).toContain("$python-game - Create Create");
    expect(text).toContain("… [skills]");
    expect(text).not.toContain("$release-notes");
  });

  it("can show all matching skills when requested", () => {
    const availableSkills = Array.from({ length: 14 }, (_, index) => ({
      name: `skill_${String(index).padStart(2, "0")}`,
    }));

    const text = formatSkillsSnapshot(
      {
        invokedSkills: [],
        availableSkills,
        effectiveSkillRoots: [],
      },
      { showAll: true },
    );

    expect(text).toContain("available: 14");
    expect(text).toContain("$skill_13");
    expect(text).not.toContain("hidden");
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
      expect(result.text).toContain("$debug");
      expect(result.text).toContain("invoked: $debug");
      expect(result.text).toContain("plugin roots: /skills");
    }
  });

  it("treats extra /skills text as a filter instead of an error", async () => {
    const result = await skillsCommand.execute({
      session: stubSession({
        availableSkills: [
          { name: "python-game", description: "Create games" },
          { name: "debug", description: "Debug failures" },
        ],
      }),
      argsRaw: "python",
      cwd: "/tmp/ws",
      home: "/home/test",
    });
    expect(result.kind).toBe("text");
    if (result.kind === "text") {
      expect(result.text).toContain("filter: python");
      expect(result.text).toContain("$python-game");
      expect(result.text).not.toContain("$debug");
    }
  });
});
