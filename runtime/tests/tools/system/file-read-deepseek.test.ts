import { mkdtemp, readFile, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { observeBoundTargets, withBoundTargets } from "../../../src/tools/bound-targets.js";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import type { ToolEvaluatorContext } from "../../../src/permissions/evaluator.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { toolIsSideEffectFree } from "../../../src/tools/side-effect-free.js";
import { attachReadOnlyDelegationReadGuard } from "../../../src/permissions/readonly-read-guard.js";
import { attachContextDefaults, hasPermissionsToUseTool } from "../../../src/permissions/evaluator.js";
import { applyToolApprovalConfigToPermissionContext } from "../../../src/permissions/tool-approval.js";
import type { ToolCallSession } from "../../../src/tools/system/session-provider-authority.js";

let root: string;
let file: string;
let session: ToolCallSession;
let enabled: boolean;
let transport: ReturnType<typeof vi.fn>;
let fixture: unknown;
function makeTool(optIn = true) {
  return bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], deepseekExtraction: optIn, getSession: () => session }));
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "file-read-ocr-")); file = join(root, "sample.docx");
  await writeFile(file, "synthetic document");
  enabled = true;
  session = { services: {
    providerService: { environment: () => ({ DEEPSEEK_API_KEY: "ocr-test-key" }) },
    configStore: { current: () => ({ tools_config: { file_read_provider: enabled ? "deepseek" : "local" } }) },
  } };
  fixture = JSON.parse(await readFile(new URL("../../llm/providers/deepseek/fixtures/standalone-ocr.json", import.meta.url), "utf8"));
  transport = vi.fn(async () => Response.json(fixture)); vi.stubGlobal("fetch", transport);
});
afterEach(async () => { vi.unstubAllGlobals(); await rm(root, { force: true, recursive: true }); });
function bound(tool: ReturnType<typeof makeTool>, args = { file_path: file, extract_text: true } as Record<string, unknown>) {
  return withBoundTargets(args, observeBoundTargets(tool, args));
}

describe("FileRead DeepSeek extraction", () => {
  test("does not expose or execute uploads by default", async () => {
    const tool = makeTool(false);
    expect((tool.inputSchema.properties as Record<string, unknown>).extract_text).toBeUndefined();
    expect((await tool.execute({ file_path: file, extract_text: true })).isError).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });
  test("opt-in alone never uploads and normal text reads stay local", async () => {
    const tool = makeTool();
    expect((await tool.execute({ file_path: file })).isError).toBe(true);
    const text = join(root, "file.txt"); await writeFile(text, "local text");
    expect((await tool.execute({ file_path: text })).content).toContain("local text");
    expect(transport).not.toHaveBeenCalled();
  });
  test("requires upload approval in addition to read permission", async () => {
    const tool = makeTool();
    const context = { session, getAppState: () => ({ toolPermissionContext: createEmptyToolPermissionContext() }) } as ToolEvaluatorContext;
    const decision = await tool.checkPermissions!({ file_path: file, extract_text: true }, context);
    expect(decision.behavior).toBe("ask"); expect(decision.message).toContain("Upload the entire file");
    expect(decision.message).toContain("DeepSeek");
    expect(toolIsSideEffectFree(tool)).toBe(false);
    expect((await tool.execute({ file_path: file, extract_text: true })).content).toContain("approved, bound file target");
    expect(transport).not.toHaveBeenCalled();
  });
  test.each(["default", "bypassPermissions"] as const)("an ordinary FileRead allow does not approve uploads in %s mode", async mode => {
    const tool = makeTool();
    const permissions = applyToolApprovalConfigToPermissionContext(createEmptyToolPermissionContext({ mode }), { allow: ["FileRead"] });
    const context = attachContextDefaults({ session, getAppState: () => ({ toolPermissionContext: permissions }) } as ToolEvaluatorContext);
    const decision = await hasPermissionsToUseTool(tool, { file_path: file, extract_text: true }, context);
    expect(decision.behavior).toBe("ask"); expect(decision.message).toContain("Upload");
    expect(transport).not.toHaveBeenCalled();
  });
  test("delegated read authority cannot upload even an allowed file", async () => {
    const tool = makeTool(); const args = bound(tool);
    attachReadOnlyDelegationReadGuard(args, () => true);
    expect((await tool.execute(args)).content).toContain("delegated read authority");
    expect(transport).not.toHaveBeenCalled();
  });
  test("returns attributed untrusted extracted text and authoritative per-page cost", async () => {
    const tool = makeTool();
    expect(tool.admissionEstimate!({ file_path: file, extract_text: true }).maxCostUsd).toBe(0.225);
    const result = await tool.execute(bound(tool));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("Content extracted by DeepSeek OCR");
    expect(result.content).toContain("UNTRUSTED TOOL RESULT DATA");
    expect(result.content).toContain("synthetic document text redacted");
    expect(result.admissionUsage?.costUsd).toBe(0.000225);
    expect(result.metadata).toBeUndefined();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test.each([".ppt", ".pptx", ".doc", ".png", ".tiff"])("offers text-only extraction for %s", async ext => {
    const path = join(root, `sample${ext}`); await writeFile(path, "synthetic");
    const tool = makeTool(); const result = await tool.execute(bound(tool, { file_path: path, extract_text: true }));
    expect(result.isError).not.toBe(true); expect(transport).toHaveBeenCalledTimes(1);
  });
  test.each([".xls", ".xlsx"])("refuses unsupported Excel %s without uploading", async ext => {
    const path = join(root, `sample${ext}`); await writeFile(path, "synthetic");
    const tool = makeTool(); const result = await tool.execute(bound(tool, { file_path: path, extract_text: true }));
    expect(result.content).toContain("DeepSeek OCR does not accept Excel"); expect(transport).not.toHaveBeenCalled();
  });
  test("never silently uploads the whole file for a requested page range", async () => {
    const tool = makeTool();
    const result = await tool.execute(bound(tool, { file_path: file, extract_text: true, pages: "1-2" }));
    expect(result.content).toContain("no page-range input"); expect(transport).not.toHaveBeenCalled();
  });
  test("rechecks live opt-in before reading or uploading", async () => {
    const tool = makeTool(); const args = bound(tool); enabled = false;
    expect((await tool.execute(args)).content).toContain("disabled in this session"); expect(transport).not.toHaveBeenCalled();
  });
  test("refuses a symlink retargeted after approval", async () => {
    const link = join(root, "link.docx"); const other = join(root, "other.docx");
    await writeFile(other, "do not upload"); await symlink(file, link);
    const tool = makeTool(); const args = bound(tool, { file_path: link, extract_text: true });
    await symlink(other, `${link}.new`); await rename(`${link}.new`, link);
    expect((await tool.execute(args)).content).toContain("changed after its upload approval"); expect(transport).not.toHaveBeenCalled();
  });
  test("rejects files larger than 100 MiB before upload", async () => {
    await truncate(file, 100 * 1024 * 1024 + 1);
    const tool = makeTool(); expect((await tool.execute(bound(tool))).isError).toBe(true); expect(transport).not.toHaveBeenCalled();
  });
  test("denies a path outside the read authority", async () => {
    const tool = makeTool();
    const result = await tool.execute({ file_path: join(root, "..", "outside.docx"), extract_text: true });
    expect(result.isError).toBe(true); expect(transport).not.toHaveBeenCalled();
  });
  test("keeps ambiguous billing unknown on an unusable response", async () => {
    transport.mockImplementation(async () => new Response("malformed"));
    const tool = makeTool(); const result = await tool.execute(bound(tool));
    expect(result.isError).toBe(true); expect(result.admissionUsage).toBeUndefined(); expect(result.content).toContain("billed");
  });
  test("bounds non-ASCII OCR output with the local byte and token budgets", async () => {
    fixture = { page_count: 1, pages: [{ index: 0, text: "漢".repeat(200), finish_reason: "stop" }] };
    const tool = bindExplicitDangerBoundary(createFileReadTool({ allowedPaths: [root], deepseekExtraction: true,
      getSession: () => session, maxTextBytes: 64, maxTokens: 10 }));
    const result = await tool.execute(bound(tool));
    expect(result.isError).not.toBe(true); expect(result.content).toContain("truncated");
    expect(result.content).not.toContain("漢".repeat(20)); expect(result.admissionUsage?.costUsd).toBe(0.000225);
  });
});
