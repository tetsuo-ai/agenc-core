import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initCommand, {
  INIT_TARGET_FILENAME,
  INIT_TEMPLATE,
  buildInitPrompt,
  resolveInitTemplate,
} from "./init.js";
import type { SlashCommandContext } from "./types.js";
import type { Session } from "../session/session.js";

function mkctx(cwd: string): SlashCommandContext {
  return {
    session: {} as Session,
    argsRaw: "",
    cwd,
    home: "/home/test",
  };
}

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "agenc-init-"));
  delete process.env.AGENC_INIT_TEMPLATE_PATH;
});
afterEach(() => {
  delete process.env.AGENC_INIT_TEMPLATE_PATH;
});

describe("initCommand", () => {
  it("returns a model prompt instead of writing the template when none exists", async () => {
    const res = await initCommand.execute(mkctx(workDir));
    const target = join(workDir, INIT_TARGET_FILENAME);
    expect(res.kind).toBe("prompt");
    if (res.kind === "prompt") {
      expect(res.content).toContain(INIT_TEMPLATE.trim());
      expect(res.content).toContain(`Repository root: ${workDir}`);
      expect(res.content).toContain(`Target file: ${target}`);
      expect(res.content).toContain("Do not write these instructions");
    }
    expect(existsSync(target)).toBe(false);
  });

  it("skips when AGENC.md already exists", async () => {
    const target = join(workDir, INIT_TARGET_FILENAME);
    writeFileSync(target, "existing content", "utf8");
    const res = await initCommand.execute(mkctx(workDir));
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/already exists/);
    expect(readFileSync(target, "utf8")).toBe("existing content");
  });

  it("prefers AGENC_INIT_TEMPLATE_PATH when readable", async () => {
    const override = join(workDir, "override.md");
    writeFileSync(override, "CUSTOM-PROMPT", "utf8");
    process.env.AGENC_INIT_TEMPLATE_PATH = override;
    expect(resolveInitTemplate()).toBe("CUSTOM-PROMPT");

    const res = await initCommand.execute(mkctx(workDir));
    expect(res.kind).toBe("prompt");
    if (res.kind === "prompt") {
      expect(res.content).toContain("CUSTOM-PROMPT");
      expect(res.content).toContain(join(workDir, INIT_TARGET_FILENAME));
    }
    expect(existsSync(join(workDir, INIT_TARGET_FILENAME))).toBe(false);
  });

  it("falls back to inline template if override path is unreadable", () => {
    process.env.AGENC_INIT_TEMPLATE_PATH = join(workDir, "nonexistent");
    expect(resolveInitTemplate()).toBe(INIT_TEMPLATE);
  });

  it("builds target-specific prompt context around the template", () => {
    const prompt = buildInitPrompt("/repo", "/repo/AGENC.md", "WRITE GUIDE");
    expect(prompt).toContain("WRITE GUIDE");
    expect(prompt).toContain("Repository root: /repo");
    expect(prompt).toContain("Target file: /repo/AGENC.md");
    expect(prompt).toContain("Write the final Markdown guide to /repo/AGENC.md");
  });
});
