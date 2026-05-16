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
        "  available:",
        "    $debug - Debug a failing workflow [skills]",
        "    $mcp__Docs_Server__reviewer - Remote review skill [mcp]",
        "  invoked: $debug",
        "  plugin roots: /skills",
      ].join("\n"),
    );
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
