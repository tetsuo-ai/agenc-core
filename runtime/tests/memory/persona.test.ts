/**
 * Persona workspace files (TODO task 13): USER.md / SOUL.md / IDENTITY.md
 * injection through the memory bootstrap, budget with truncation-on-disk-
 * intact semantics, zero overhead when absent, and the mechanical
 * exactly-once BOOTSTRAP.md ritual gate.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getOriginalCwd,
  getProjectRoot,
  setOriginalCwd,
  setProjectRoot,
} from "../bootstrap/state.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));
vi.mock("../tools/GrepTool/prompt.js", () => ({ GREP_TOOL_NAME: "Grep" }));
vi.mock("../tools/REPLTool/constants.js", () => ({ isReplModeEnabled: () => false }));
vi.mock("../utils/embeddedTools.js", () => ({ hasEmbeddedSearchTools: () => false }));
vi.mock("../utils/sessionStorage.js", () => ({ getProjectDir: (cwd: string) => cwd }));
vi.mock("../utils/hooks.js", () => ({
  executeInstructionsLoadedHooks: async () => undefined,
  hasInstructionsLoadedHook: () => false,
}));
vi.mock("../tools.js", () => ({}));
vi.mock("src/tools.js", () => ({}));
vi.mock("../utils/settings/settings.js", () => ({
  getInitialSettings: () => ({}),
  getSettingsForSource: () => undefined,
}));

let agencmd: typeof import("./agencmd.js");
let persona: typeof import("./persona.js");

let tempRoot = "";
let repo = "";
let oldProjectRoot = "";
let oldOriginalCwd = "";
let oldConfigDir: string | undefined;

beforeAll(async () => {
  agencmd = await import("./agencmd.js");
  persona = await import("./persona.js");
}, 30_000);

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), "agenc-persona-"));
  oldProjectRoot = getProjectRoot();
  oldOriginalCwd = getOriginalCwd();
  oldConfigDir = process.env.AGENC_CONFIG_DIR;
  process.env.AGENC_CONFIG_DIR = join(tempRoot, "home");
  repo = join(tempRoot, "repo");
  mkdirSync(repo, { recursive: true });
  setProjectRoot(repo);
  setOriginalCwd(repo);
  agencmd.clearMemoryFileCaches();
});

afterEach(() => {
  setProjectRoot(oldProjectRoot);
  setOriginalCwd(oldOriginalCwd);
  if (oldConfigDir === undefined) delete process.env.AGENC_CONFIG_DIR;
  else process.env.AGENC_CONFIG_DIR = oldConfigDir;
  agencmd.clearMemoryFileCaches();
  rmSync(tempRoot, { recursive: true, force: true });
});

afterAll(() => {
  vi.resetModules();
});

function personaEntries(files: { path: string }[]): string[] {
  return files
    .map((f) => f.path)
    .filter((p) =>
      ["USER.md", "SOUL.md", "IDENTITY.md", "BOOTSTRAP.md"].some((n) =>
        p.endsWith(`${join(repo, n)}`.slice(repo.length)),
      ),
    );
}

describe("persona workspace files", () => {
  it("absent files inject nothing (zero overhead)", async () => {
    const files = await agencmd.getMemoryFiles();
    expect(personaEntries(files)).toEqual([]);
  });

  it("injects USER.md / SOUL.md / IDENTITY.md from the workspace root, above AGENC.md", async () => {
    writeFileSync(join(repo, "AGENC.md"), "Project instructions here.");
    writeFileSync(join(repo, "USER.md"), "The human is Tetsuo.");
    writeFileSync(join(repo, "SOUL.md"), "You are direct and calm.");
    writeFileSync(join(repo, "IDENTITY.md"), "Your name is Hikari.");

    const files = await agencmd.getMemoryFiles();
    const paths = files.map((f) => f.path);

    const agencIdx = paths.indexOf(join(repo, "AGENC.md"));
    const userIdx = paths.indexOf(join(repo, "USER.md"));
    const soulIdx = paths.indexOf(join(repo, "SOUL.md"));
    const identityIdx = paths.indexOf(join(repo, "IDENTITY.md"));

    expect(agencIdx).toBeGreaterThanOrEqual(0);
    expect(userIdx).toBeGreaterThan(agencIdx);
    expect(soulIdx).toBeGreaterThan(userIdx);
    expect(identityIdx).toBeGreaterThan(soulIdx);

    const soul = files[soulIdx];
    expect(soul.type).toBe("Project");
    expect(soul.content).toBe("You are direct and calm.");
    expect(soul.contentDiffersFromDisk).toBeUndefined();
  });

  it("persona files are NOT loaded from ancestor directories", async () => {
    // SOUL.md in the PARENT of the workspace must not leak in.
    writeFileSync(join(tempRoot, "SOUL.md"), "wrong soul");
    const files = await agencmd.getMemoryFiles();
    expect(files.map((f) => f.path)).not.toContain(join(tempRoot, "SOUL.md"));
  });

  it("budget: oversized SOUL.md is truncated in the prompt while disk stays intact", async () => {
    const line = "persona boundary line that repeats for budget testing\n";
    const big = line.repeat(
      Math.ceil((persona.PERSONA_FILE_MAX_BYTES * 2) / line.length),
    );
    writeFileSync(join(repo, "SOUL.md"), big);

    const files = await agencmd.getMemoryFiles();
    const soul = files.find((f) => f.path === join(repo, "SOUL.md"));

    expect(soul).toBeDefined();
    expect(
      Buffer.byteLength(soul!.content, "utf8"),
    ).toBeLessThanOrEqual(persona.PERSONA_FILE_MAX_BYTES + 256);
    expect(soul!.content).toContain("SOUL.md truncated for context");
    expect(soul!.content).toContain("file on disk is intact");
    expect(soul!.contentDiffersFromDisk).toBe(true);
    expect(soul!.rawContent).toBe(big);
    // Disk untouched.
    expect(readFileSync(join(repo, "SOUL.md"), "utf8")).toBe(big);
  });

  it("BOOTSTRAP.md ritual: injected with the ritual frame only while IDENTITY.md is absent", async () => {
    writeFileSync(
      join(repo, "BOOTSTRAP.md"),
      "Choose a name that fits this workspace.",
    );

    const files = await agencmd.getMemoryFiles();
    const bootstrap = files.find((f) => f.path === join(repo, "BOOTSTRAP.md"));

    expect(bootstrap).toBeDefined();
    expect(bootstrap!.content).toContain("one-time bootstrap ritual");
    expect(bootstrap!.content).toContain("writing IDENTITY.md");
    expect(bootstrap!.content).toContain("delete BOOTSTRAP.md");
    expect(bootstrap!.content).toContain(
      "Choose a name that fits this workspace.",
    );
    // The frame means injected bytes never match disk bytes.
    expect(bootstrap!.contentDiffersFromDisk).toBe(true);
    expect(bootstrap!.rawContent).toBe(
      "Choose a name that fits this workspace.",
    );
  });

  it("BOOTSTRAP.md ritual runs exactly once: never injected once IDENTITY.md exists", async () => {
    writeFileSync(join(repo, "BOOTSTRAP.md"), "Naming ceremony.");

    // First load: ritual present.
    let files = await agencmd.getMemoryFiles();
    expect(
      files.some((f) => f.path === join(repo, "BOOTSTRAP.md")),
    ).toBe(true);

    // The ritual completes: IDENTITY.md is written — but the agent forgot to
    // delete BOOTSTRAP.md. The gate must still hold.
    writeFileSync(join(repo, "IDENTITY.md"), "Your name is Hikari.");
    agencmd.clearMemoryFileCaches();

    files = await agencmd.getMemoryFiles();
    expect(
      files.some((f) => f.path === join(repo, "BOOTSTRAP.md")),
    ).toBe(false);
    expect(
      files.some((f) => f.path === join(repo, "IDENTITY.md")),
    ).toBe(true);
  });

  it("a persona file pulled in via @include is not injected twice", async () => {
    writeFileSync(join(repo, "AGENC.md"), "Instructions.\n\n@SOUL.md\n");
    writeFileSync(join(repo, "SOUL.md"), "You are direct and calm.");

    const files = await agencmd.getMemoryFiles();
    const soulEntries = files.filter(
      (f) => f.path === join(repo, "SOUL.md"),
    );
    expect(soulEntries).toHaveLength(1);
  });
});

describe("loadPersonaPromptSection (the LIVE system-prompt injection)", () => {
  it("returns null when no persona file exists (zero prompt overhead)", async () => {
    expect(await persona.loadPersonaPromptSection(repo)).toBeNull();
  });

  it("builds one section with per-file blocks in priority order", async () => {
    writeFileSync(join(repo, "USER.md"), "The human is Tetsuo.");
    writeFileSync(join(repo, "SOUL.md"), "You are direct and calm.");
    writeFileSync(join(repo, "IDENTITY.md"), "Your name is Hikari.");

    const section = await persona.loadPersonaPromptSection(repo);
    expect(section).toContain("# Persona");
    const user = section!.indexOf("## USER.md");
    const soul = section!.indexOf("## SOUL.md");
    const identity = section!.indexOf("## IDENTITY.md");
    expect(user).toBeGreaterThan(-1);
    expect(soul).toBeGreaterThan(user);
    expect(identity).toBeGreaterThan(soul);
    expect(section).toContain("You are direct and calm.");
    expect(section).toContain("never override permission gates");
  });

  it("frames BOOTSTRAP.md only while IDENTITY.md is absent", async () => {
    writeFileSync(join(repo, "BOOTSTRAP.md"), "Naming ceremony.");

    let section = await persona.loadPersonaPromptSection(repo);
    expect(section).toContain("## BOOTSTRAP.md");
    expect(section).toContain("one-time bootstrap ritual");

    writeFileSync(join(repo, "IDENTITY.md"), "Your name is Hikari.");
    section = await persona.loadPersonaPromptSection(repo);
    expect(section).toContain("## IDENTITY.md");
    expect(section).not.toContain("## BOOTSTRAP.md");
    expect(section).not.toContain("one-time bootstrap ritual");
  });
});

describe("persona live-wiring contract", () => {
  // The LIVE injection point is constants/prompts.ts getSystemPrompt — the
  // builder behind buildBaseInstructionsForModel (daemon/CLI turns). This
  // source contract mirrors session-memory.contract.test.ts: it guards the
  // wiring itself, since the builder's heavy dependency graph makes a full
  // unit instantiation impractical. Live injection was capture-verified
  // against a real `agenc -p` run (task 13).
  it("wires loadPersonaPromptSection into the live system-prompt builder", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const source = readFileSync(
      resolve(process.cwd(), "src/constants/prompts.ts"),
      "utf8",
    );
    expect(source).toContain(
      "systemPromptSection('persona', () => loadPersonaPromptSection(cwd))",
    );
    // The simple-proactive early-return path must inject it too.
    expect(source).toContain("await loadPersonaPromptSection(cwd)");
  });
});

describe("capPersonaContent", () => {
  it("passes small content through untouched", () => {
    const r = persona.capPersonaContent("SOUL.md", "  hello\nworld  \n");
    expect(r).toEqual({ content: "hello\nworld", truncated: false });
  });

  it("cuts at a line boundary and names the file in the marker", () => {
    const line = "x".repeat(100) + "\n";
    const big = line.repeat(
      Math.ceil((persona.PERSONA_FILE_MAX_BYTES + 4096) / line.length),
    );
    const r = persona.capPersonaContent("USER.md", big);
    expect(r.truncated).toBe(true);
    expect(r.content).toContain("USER.md truncated for context");
    const body = r.content.split("\n\n[")[0];
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
      persona.PERSONA_FILE_MAX_BYTES,
    );
    // Every retained line is whole.
    for (const l of body.split("\n")) expect(l).toBe("x".repeat(100));
  });
});
