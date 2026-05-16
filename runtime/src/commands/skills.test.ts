import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import skillsCommand, {
  collectSkillsSnapshot,
  createProjectSkill,
  formatSkillsSnapshot,
} from "./skills.js";
import type { Session } from "../session/session.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "agenc-skills-command-"));
}

function stubSession(opts: {
  invokedSkills?: readonly string[];
  availableSkills?: ReadonlyArray<{
    readonly name: string;
    readonly description?: string;
    readonly scope?: string;
    readonly loadedFrom?: string;
    readonly userInvocable?: boolean;
    readonly disableModelInvocation?: boolean;
    readonly aliases?: readonly string[];
  }>;
  roots?: unknown;
  clearSkillCaches?: () => void;
}): Session {
  return {
    config: { model: "test" },
    services: {
      skillsManager: {
        clearSkillCaches: opts.clearSkillCaches,
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
          aliases: undefined,
        },
        {
          name: "zeta",
          description: undefined,
          scope: undefined,
          loadedFrom: undefined,
          userInvocable: undefined,
          disableModelInvocation: undefined,
          aliases: undefined,
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
        aliases: undefined,
      },
      {
        name: "mcp__Docs_Server__reviewer",
        description: "Remote review skill",
        scope: undefined,
        loadedFrom: "mcp",
        userInvocable: true,
        disableModelInvocation: false,
        aliases: undefined,
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

  it("formats hidden system skills with their invocable aliases", () => {
    const text = formatSkillsSnapshot({
      invokedSkills: [".system:imagegen"],
      availableSkills: [
        {
          name: ".system:imagegen",
          aliases: ["imagegen"],
          description: "Generate image assets",
          loadedFrom: "skills",
        },
      ],
      effectiveSkillRoots: [],
    });

    expect(text).toContain("    $imagegen - Generate image assets [system]");
    expect(text).toContain("  invoked: $imagegen");
  });

  it("keeps visible skill descriptions under AgenC branding", () => {
    const donorName = ["Co", "dex"].join("");
    const donorEnv = ["CO", "DEX"].join("");
    const donorSource = ["co", "dex"].join("");
    const text = formatSkillsSnapshot({
      invokedSkills: [],
      availableSkills: [
        {
          name: "plugin-creator",
          description: `Create plugins for ${donorName} in $${donorEnv}_HOME.`,
          loadedFrom: donorSource,
        },
      ],
      effectiveSkillRoots: [],
    });

    expect(text).toContain(
      "$plugin-creator - Create plugins for AgenC in $AGENC_HOME. [agenc]",
    );
    expect(text).not.toContain(donorName);
    expect(text).not.toContain(donorSource);
    expect(text).not.toContain(donorEnv);
  });

  it("keeps exact command names ahead of implicit aliases", () => {
    expect(
      formatSkillsSnapshot({
        invokedSkills: [],
        availableSkills: [
          {
            name: ".system:imagegen",
            aliases: ["imagegen"],
            loadedFrom: "skills",
          },
          { name: "imagegen", description: "Project image skill" },
        ],
        effectiveSkillRoots: [],
      }),
    ).toContain("    $imagegen - Project image skill");
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

    expect(text).toContain("available: showing 8 of 14");
    expect(text).toContain("$skill_00 - Skill 0 does useful work [skills]");
    expect(text).not.toContain("$skill_13");
    expect(text).toContain("more: 6 hidden; use /skills all or /skills <search>");
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

  it("opens a persistent skills menu in the interactive TUI", async () => {
    const setToolJSX = vi.fn();
    const result = await skillsCommand.execute({
      session: stubSession({
        invokedSkills: ["debug"],
        availableSkills: [{ name: "debug", description: "Debug failures" }],
        roots: ["/skills"],
      }),
      argsRaw: "",
      cwd: "/tmp/ws",
      home: "/home/test",
      appState: {
        setToolJSX,
      },
    });

    expect(result).toEqual({ kind: "skip" });
    expect(setToolJSX).toHaveBeenCalledTimes(1);
    const surface = setToolJSX.mock.calls[0]?.[0] as {
      isLocalJSXCommand?: boolean;
      shouldHidePromptInput?: boolean;
      jsx?: { props?: { snapshot?: { availableSkills?: readonly { name: string }[] } } };
    };
    expect(surface.isLocalJSXCommand).toBe(true);
    expect(surface.shouldHidePromptInput).toBe(true);
    expect(surface.jsx?.props?.snapshot?.availableSkills?.[0]?.name).toBe("debug");
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

  it("creates a project skill and points invocation at the dollar skill form", async () => {
    const cwd = tmpRoot();
    let cleared = false;
    try {
      const result = await skillsCommand.execute({
        session: stubSession({
          clearSkillCaches: () => {
            cleared = true;
          },
        }),
        argsRaw: "new python-game Create Python terminal games",
        cwd,
        home: "/home/test",
      });

      const skillFile = join(cwd, ".agenc", "skills", "python-game", "SKILL.md");
      expect(result.kind).toBe("text");
      if (result.kind === "text") {
        expect(result.text).toContain(
          "Created skill: .agenc/skills/python-game/SKILL.md",
        );
        expect(result.text).toContain("Invoke it with: $python-game");
        expect(result.text).not.toContain("Invoke it with: /python-game");
      }
      expect(cleared).toBe(true);
      expect(readFileSync(skillFile, "utf8")).toContain(
        'description: "Create Python terminal games"',
      );
      expect(readFileSync(skillFile, "utf8")).toContain(
        "Use this skill when the user asks for: Create Python terminal games.",
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates namespaced skills as nested directories", async () => {
    const cwd = tmpRoot();
    try {
      const result = await createProjectSkill(
        cwd,
        "frontend:react:form",
        "Build React form flows",
      );

      expect(result).toEqual({
        text: [
          "Created skill: .agenc/skills/frontend/react/form/SKILL.md",
          "Invoke it with: $frontend:react:form",
          "Edit SKILL.md, then run $frontend:react:form.",
        ].join("\n"),
      });
      expect(
        existsSync(
          join(cwd, ".agenc", "skills", "frontend", "react", "form", "SKILL.md"),
        ),
      ).toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects unsafe skill names before writing files", async () => {
    const cwd = tmpRoot();
    try {
      const result = await createProjectSkill(cwd, "../bad", "Bad skill");

      expect(result).toEqual({
        error:
          "Usage: /skills new <skill-name> [description]\nNames must use letters, numbers, _, -, and optional : namespaces.",
      });
      expect(existsSync(join(cwd, ".agenc"))).toBe(false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing skill", async () => {
    const cwd = tmpRoot();
    try {
      const skillDir = join(cwd, ".agenc", "skills", "existing");
      mkdirSync(skillDir, { recursive: true });
      const skillFile = join(skillDir, "SKILL.md");
      writeFileSync(skillFile, "original", "utf8");

      const result = await createProjectSkill(cwd, "existing", "Replacement");

      expect(result).toEqual({
        error: "Skill already exists: .agenc/skills/existing/SKILL.md",
      });
      expect(readFileSync(skillFile, "utf8")).toBe("original");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
