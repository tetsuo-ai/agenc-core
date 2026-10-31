import { afterEach, describe, expect, it, vi } from "vitest";

// Job og: a daemon session's first ordinary submit loaded the turn kernel, the
// model-facing tools and the cron store, and built the MCP configuration
// schema, between the user's Enter and the first model request. The preload
// does that work while the session waits, without running any startup effect.

const evaluated = vi.hoisted(() => ({
  runTurn: 0,
  modelFacingTools: 0,
  cronTasks: 0,
  mcpParses: [] as unknown[],
  patternTests: [] as string[],
}));

vi.mock("../../src/session/run-turn.js", async (importOriginal) => {
  evaluated.runTurn += 1;
  return importOriginal();
});
vi.mock("../../src/bin/model-facing-tools.js", async (importOriginal) => {
  evaluated.modelFacingTools += 1;
  const actual = await importOriginal<typeof import("../../src/bin/model-facing-tools.js")>();
  return {
    ...actual,
    resumeInterruptedAgentJobs: vi.fn(() => {
      throw new Error("the preload must not resume interrupted jobs");
    }),
    startCronSchedulerRunner: vi.fn(() => {
      throw new Error("the preload must not start the cron runner");
    }),
  };
});
vi.mock("../../src/utils/cronTasks.js", async (importOriginal) => {
  evaluated.cronTasks += 1;
  return importOriginal();
});
vi.mock("../../src/services/mcp/types.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/services/mcp/types.js")>();
  return {
    ...actual,
    McpJsonConfigSchema: () => {
      const schema = actual.McpJsonConfigSchema();
      return {
        safeParse: (value: unknown) => {
          evaluated.mcpParses.push(value);
          return schema.safeParse(value);
        },
      };
    },
  };
});

vi.mock("../../src/prompts/attachments/memory-on-request.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/prompts/attachments/memory-on-request.js")>();
  return {
    ...actual,
    asksAboutMemory: (text: string) => {
      evaluated.patternTests.push(`memory:${text}`);
      return actual.asksAboutMemory(text);
    },
  };
});
vi.mock("../../src/prompts/attachments/product-help.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/prompts/attachments/product-help.js")>();
  return {
    ...actual,
    asksAboutUndo: (text: string) => {
      evaluated.patternTests.push(`undo:${text}`);
      return actual.asksAboutUndo(text);
    },
    asksAboutInstructionFiles: (text: string) => {
      evaluated.patternTests.push(`instructions:${text}`);
      return actual.asksAboutInstructionFiles(text);
    },
  };
});

vi.mock("marked", async (importOriginal) => {
  const actual = await importOriginal<typeof import("marked")>();
  class CountingLexer extends actual.Lexer {
    static override lex(src: string, options?: Parameters<typeof actual.Lexer.lex>[1]) {
      evaluated.patternTests.push(`markdown:${src.length > 0 ? "sample" : ""}`);
      return actual.Lexer.lex(src, options);
    }
  }
  return { ...actual, Lexer: CountingLexer };
});

afterEach(() => vi.restoreAllMocks());

describe("first-submit preload", () => {
  it("loads the first-submit modules once per process and runs no startup effect", async () => {
    const { preloadOrdinarySubmitModules } = await import("../../src/bin/bootstrap.js");
    const tools = await import("../../src/bin/model-facing-tools.js");
    const before = { ...evaluated, mcpParses: [...evaluated.mcpParses], patternTests: [...evaluated.patternTests] };
    const first = preloadOrdinarySubmitModules();
    expect(preloadOrdinarySubmitModules()).toBe(first);
    await first;
    expect(evaluated.runTurn).toBeGreaterThanOrEqual(1);
    expect(evaluated.modelFacingTools).toBeGreaterThanOrEqual(1);
    expect(evaluated.cronTasks).toBeGreaterThanOrEqual(1);
    // Exactly one schema warm-up, on an empty configuration (no I/O).
    expect(evaluated.mcpParses.slice(before.mcpParses.length)).toEqual([{ mcpServers: {} }]);
    expect(tools.resumeInterruptedAgentJobs).not.toHaveBeenCalled();
    expect(tools.startCronSchedulerRunner).not.toHaveBeenCalled();
    // The first request's attachment patterns are compiled (two tests each, so
    // V8 also tiers them up), on an empty string only; the Markdown lexer lexes
    // a sample twice.
    const tested = evaluated.patternTests.slice(before.patternTests.length);
    expect(tested.filter((entry) => entry === "memory:")).toHaveLength(2);
    expect(tested.filter((entry) => entry === "undo:")).toHaveLength(2);
    expect(tested.filter((entry) => entry === "instructions:")).toHaveLength(2);
    // The Markdown lexer needs real content to compile its rules.
    expect(tested.filter((entry) => entry === "markdown:sample")).toHaveLength(2);
    expect(tested.filter((entry) => !entry.startsWith("markdown:")).every((entry) => entry.endsWith(":"))).toBe(true);
    // A second call neither loads nor parses again.
    await preloadOrdinarySubmitModules();
    expect(evaluated.mcpParses.length).toBe(before.mcpParses.length + 1);
    expect(evaluated.patternTests.length).toBe(before.patternTests.length + tested.length);
  });
});
