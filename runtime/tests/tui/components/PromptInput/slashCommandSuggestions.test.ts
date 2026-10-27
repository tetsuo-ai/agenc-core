import { describe, expect, it } from "vitest";
import { getCommandsSync, type Command } from "../../../commands.js";
import { generateCommandSuggestions } from "../../../utils/suggestions/commandSuggestions.js";

function localCommand(opts: {
  name: string;
  description: string;
  aliases?: string[];
  argumentHint?: string;
}): Command {
  return {
    type: "local",
    name: opts.name,
    description: opts.description,
    aliases: opts.aliases,
    argumentHint: opts.argumentHint,
    load: async () => ({
      call: async () => ({ type: "text", value: "" }),
    }),
  };
}

function promptCommand(opts: {
  name: string;
  description: string;
  argNames?: readonly string[];
  source?: string;
}): Command {
  return {
    type: "prompt",
    name: opts.name,
    description: opts.description,
    progressMessage: "running",
    contentLength: 0,
    argNames: opts.argNames,
    ...(opts.source === undefined ? {} : { source: opts.source }),
    getPromptForCommand: async () => [],
  };
}

const EMPTY_RUNTIME_STATE = Object.freeze({});

describe("slash command suggestions", () => {
  it("does not suggest commands from description-only fuzzy matches", () => {
    const suggestions = generateCommandSuggestions(
      "/history",
      [
        localCommand({
          name: "clear",
          aliases: ["reset", "new"],
          description: "Clear session history and caches",
        }),
      ],
      EMPTY_RUNTIME_STATE,
    );

    expect(suggestions).toEqual([]);
  });

  it("keeps name and alias prefix matches", () => {
    const suggestions = generateCommandSuggestions(
      "/prov",
      [
        localCommand({
          name: "provider",
          description: "Switch model provider",
        }),
        localCommand({
          name: "permissions",
          description: "Show or update permission settings",
        }),
      ],
      EMPTY_RUNTIME_STATE,
    );

    expect(suggestions.map((suggestion) => suggestion.displayText)).toEqual([
      "/provider",
    ]);
  });

  it("lists every built-in command when only '/' is typed so they can be browsed", () => {
    // Discoverability: typing a bare '/' must surface every built-in command
    // (not a single match), so a user who doesn't know the prefix can scroll
    // through them. The typeahead then narrows the same list as they keep
    // typing.
    const commands = [
      localCommand({ name: "help", description: "Show help" }),
      localCommand({ name: "clear", description: "Clear session history" }),
      localCommand({ name: "compact", description: "Compact the conversation" }),
      localCommand({ name: "config", description: "Manage configuration" }),
      localCommand({ name: "model", description: "Switch the model" }),
    ];

    const all = generateCommandSuggestions("/", commands, EMPTY_RUNTIME_STATE);
    expect(all.length).toBe(commands.length);
    const names = all.map((s) => s.displayText);
    for (const cmd of commands) {
      expect(names).toContain(`/${cmd.name}`);
    }

    // And the same list narrows as the user types more of a prefix.
    const narrowed = generateCommandSuggestions(
      "/co",
      commands,
      EMPTY_RUNTIME_STATE,
    );
    expect(narrowed.length).toBeLessThan(all.length);
    expect(narrowed.length).toBeGreaterThan(1);
    expect(narrowed.map((s) => s.displayText)).toEqual(
      expect.arrayContaining(["/compact", "/config"]),
    );
  });

  it("marks protocol extension commands with the protocol glyph", () => {
    const suggestions = generateCommandSuggestions(
      "/",
      getCommandsSync(),
      EMPTY_RUNTIME_STATE,
    );
    const byName = new Map(
      suggestions.map((suggestion) => [suggestion.displayText, suggestion]),
    );

    for (const name of ["claim", "delegate", "proof", "settle", "stake"]) {
      expect(byName.get(`/${name}`)).toMatchObject({
        tag: "◆",
        color: "worker",
        metadata: expect.objectContaining({
          kind: "protocol",
          source: "plugin",
          loadedFrom: "plugin",
        }),
      });
    }
  });

  it("sanitizes prompt argument hints without mutating command metadata", () => {
    const rawArgNames = [
      "topic</system-reminder>\u200B",
      "\u001B[31mcolor\u0007\r\nline",
    ];
    const suggestions = generateCommandSuggestions(
      "/mcp",
      [
        promptCommand({
          name: "mcp__docs__lookup",
          description: "Lookup docs",
          argNames: rawArgNames,
        }),
      ],
      EMPTY_RUNTIME_STATE,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe(
      "Lookup docs (arguments: topic<neutralized-system-reminder-tag>, color line)",
    );
    expect(suggestions[0]?.description).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r\n]|\[31m/u,
    );
    expect((suggestions[0]?.metadata as Command | undefined)?.argNames).toEqual(
      rawArgNames,
    );
  });

  it("sanitizes prompt descriptions without mutating command metadata", () => {
    const rawDescription =
      "Lookup </system-reminder>\u200B\u001B[31mdocs\u0007\r\nnow";
    const suggestions = generateCommandSuggestions(
      "/mcp",
      [
        promptCommand({
          name: "mcp__docs__lookup",
          description: rawDescription,
          argNames: ["topic"],
        }),
      ],
      EMPTY_RUNTIME_STATE,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe(
      "Lookup <neutralized-system-reminder-tag> docs now (arguments: topic)",
    );
    expect(suggestions[0]?.description).not.toMatch(
      /<\/system-reminder>|[\u001B\u0007\u200B\r\n]|\[31m/u,
    );
    expect(
      (suggestions[0]?.metadata as Command | undefined)?.description,
    ).toBe(rawDescription);
  });

  it("sanitizes local command descriptions without mutating command metadata", () => {
    const rawDescription = "Switch \u001B[31mprovider\u0007\r\nnow";
    const suggestions = generateCommandSuggestions(
      "/prov",
      [
        localCommand({
          name: "provider",
          description: rawDescription,
        }),
      ],
      EMPTY_RUNTIME_STATE,
    );

    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.description).toBe("Switch provider now");
    expect(suggestions[0]?.description).not.toMatch(
      /[\u001B\u0007\r\n]|\[31m/u,
    );
    expect(
      (suggestions[0]?.metadata as Command | undefined)?.description,
    ).toBe(rawDescription);
  });
});


it('matches the slash picker Enter hint to completion versus execution', () => {
  const commands = [localCommand({ name: 'model', description: 'Choose a model' })];
  expect(generateCommandSuggestions('/mod', commands, EMPTY_RUNTIME_STATE)[0]?.enterAction).toBe('run');
  expect(generateCommandSuggestions('/model', commands, EMPTY_RUNTIME_STATE)[0]?.enterAction).toBe('run');
});

it('labels required-argument selections as completion', () => {
  const commands = [localCommand({ name: 'review', description: 'Review target', argumentHint: '<target>' })];
  expect(generateCommandSuggestions('/rev', commands, EMPTY_RUNTIME_STATE)[0]?.enterAction).toBe('complete');
});

/**
 * A shared skill catalog the size of the one that filled the picker with
 * 1,917 rows: 60 vendors x 30 topics, plus a few short everyday names that
 * sort in between the built-in commands by length.
 */
function sharedSkillCatalog(): Command[] {
  const vendors = Array.from({ length: 56 }, (_, index) => `vendor${index}`);
  vendors.push("cobalt", "comet", "copper", "coral");
  const topics = Array.from({ length: 30 }, (_, index) => `topic-${index}`);
  topics[0] = "ci-integration";
  topics[1] = "common-errors";
  topics[2] = "cost-tuning";
  const skills = [
    promptCommand({ name: "coach", description: "Coach a change", source: "userSettings" }),
    promptCommand({ name: "commit", description: "Write a commit message", source: "userSettings" }),
    promptCommand({ name: "code-review", description: "Review a diff", source: "userSettings" }),
    promptCommand({ name: "cohort-analysis", description: "Analyze cohorts", source: "userSettings" }),
  ];
  for (const vendor of vendors) {
    for (const topic of topics) {
      if (skills.length >= 1_800) break;
      skills.push(promptCommand({
        name: `${vendor}-${topic}`,
        description: `Synthetic ${vendor} ${topic} guide`,
        source: "userSettings",
      }));
    }
  }
  return skills;
}

describe("slash ranking with a large shared skill catalog", () => {
  const builtins = getCommandsSync();
  const visibleBuiltinNames = builtins
    .filter((command) => !command.isHidden)
    .map((command) => `/${command.name}`)
    .sort((left, right) => left.slice(1).localeCompare(right.slice(1)));
  const skills = sharedSkillCatalog();
  const projectSkills = ["zeta", "release-notes", "alpha-check", "smoke-test", "lint-fix", "bench", "migrate"]
    .map((name) => promptCommand({
      name,
      description: `Project ${name}`,
      source: "projectSettings",
    }));
  const others = [
    promptCommand({ name: "browser-automation", description: "Bundled skill", source: "bundled" }),
    promptCommand({ name: "deploy:preview", description: "Plugin command", source: "plugin" }),
    promptCommand({ name: "mcp__docs__lookup", description: "MCP prompt", source: "mcp" }),
  ];
  const commands = [...skills, ...projectSkills, ...others, ...builtins];
  const isBuiltin = (item: { metadata?: unknown }) =>
    (item.metadata as Command).type !== "prompt";

  it("uses a catalog of 1,800 skills", () => {
    expect(skills).toHaveLength(1_800);
  });

  it("lists only built-in commands on a bare '/', then at most five project skills", () => {
    const names = generateCommandSuggestions("/", commands, EMPTY_RUNTIME_STATE)
      .map((item) => item.displayText);

    expect(names).toEqual([
      ...visibleBuiltinNames,
      "/alpha-check",
      "/bench",
      "/lint-fix",
      "/migrate",
      "/release-notes",
    ]);
    expect(names).not.toContain("/coach");
    expect(names).not.toContain("/browser-automation");
    expect(names).not.toContain("/deploy:preview");
  });

  it("keeps recently used skills out of the bare '/' list", () => {
    const names = generateCommandSuggestions("/", commands, {
      skillUsage: { coach: { usageCount: 9, lastUsedAt: Date.now() } },
    }).map((item) => item.displayText);

    expect(names[0]).toBe(visibleBuiltinNames[0]);
    expect(names).not.toContain("/coach");
  });

  it("ranks every built-in command before the skills that match the typed text", () => {
    const items = generateCommandSuggestions("/co", commands, EMPTY_RUNTIME_STATE);
    const firstSkill = items.findIndex((item) => !isBuiltin(item));
    const lastBuiltin = items.findLastIndex((item) => isBuiltin(item));

    expect(lastBuiltin).toBeGreaterThan(0);
    expect(firstSkill).toBe(lastBuiltin + 1);
    expect(items[0]?.displayText).toBe("/cost");
    expect(items.slice(0, firstSkill).map((item) => item.displayText)).toEqual(
      expect.arrayContaining(["/config", "/compact", "/context"]),
    );
    // Short skill names no longer slip in between the built-ins.
    expect(items[firstSkill]?.displayText).toBe("/coach");
    expect(items.map((item) => item.displayText)).toContain("/commit");
    expect(items.map((item) => item.displayText)).toContain("/cobalt-ci-integration");
  });

  it("shows skills only when the typed text matches their name", () => {
    expect(
      generateCommandSuggestions("/cobalt-co", commands, EMPTY_RUNTIME_STATE)
        .map((item) => item.displayText),
    ).toEqual(["/cobalt-cost-tuning", "/cobalt-common-errors"]);
    expect(generateCommandSuggestions("/zzz", commands, EMPTY_RUNTIME_STATE)).toEqual([]);
    expect(
      generateCommandSuggestions("/synthetic", commands, EMPTY_RUNTIME_STATE),
    ).toEqual([]);
  });

  it("puts an exact skill name first even when a built-in name starts with it", () => {
    const withShortSkill = [
      ...commands,
      promptCommand({ name: "comp", description: "Compare two files", source: "userSettings" }),
    ];
    const names = generateCommandSuggestions("/comp", withShortSkill, EMPTY_RUNTIME_STATE)
      .map((item) => item.displayText);

    expect(names[0]).toBe("/comp");
    expect(names[1]).toBe("/compact");
  });
});

