import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import initCommand, {
  INIT_TARGET_FILENAME,
  INIT_TEMPLATE,
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
  it("writes AGENC.md with the default template when none exists", async () => {
    const res = await initCommand.execute(mkctx(workDir));
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/Created /);
    const target = join(workDir, INIT_TARGET_FILENAME);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toBe(INIT_TEMPLATE);
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
    writeFileSync(override, "CUSTOM-TEMPLATE", "utf8");
    process.env.AGENC_INIT_TEMPLATE_PATH = override;
    expect(resolveInitTemplate()).toBe("CUSTOM-TEMPLATE");

    const res = await initCommand.execute(mkctx(workDir));
    expect(res.kind).toBe("text");
    const written = readFileSync(join(workDir, INIT_TARGET_FILENAME), "utf8");
    expect(written).toBe("CUSTOM-TEMPLATE");
  });

  it("falls back to inline template if override path is unreadable", () => {
    process.env.AGENC_INIT_TEMPLATE_PATH = join(workDir, "nonexistent");
    expect(resolveInitTemplate()).toBe(INIT_TEMPLATE);
  });
});
