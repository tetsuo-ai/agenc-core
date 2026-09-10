import { mkdir, mkdtemp, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGrepTool } from "../../../src/tools/system/grep.js";
import { createGlobTool } from "../../../src/tools/system/glob.js";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import { attachReadOnlyDelegationReadGuard } from "../../../src/permissions/readonly-read-guard.js";
import { bindExplicitDangerBoundary } from "../../helpers/explicit-danger-boundary.js";
import { sha256, workspaceMutationCoordinators } from "../../../src/workspace/mutation-coordinator.js";
import { clearSessionReadState, getSessionReadSnapshot, signSessionId } from "../../../src/tools/system/filesystem.js";
import { MAX_GREP_DECODED_BYTES } from "../../../src/tools/system/ripgrep-protocol.js";

let workspace = "";
beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "agenc-readonly-search-"));
  await mkdir(join(workspace, "private"));
  await writeFile(join(workspace, "public.ts"), "needle public\n");
  await writeFile(join(workspace, "secret.ts"), "needle secret\n");
  await writeFile(join(workspace, "private", "nested.ts"), "needle nested\n");
});
afterEach(async () => {
  clearSessionReadState("readonly-search-session");
  workspaceMutationCoordinators.clearForTests();
  await rm(workspace, { recursive: true, force: true });
});

function guarded(args: Record<string, unknown>): Record<string, unknown> {
  attachReadOnlyDelegationReadGuard(args, path => !path.endsWith("secret.ts") && !path.includes(`${workspace}/private`) && !path.endsWith(".ignore"));
  return args;
}

describe("read-only delegated search authority", () => {
  it("refuses FileRead after live authority changes at the final path boundary", async () => {
    let allowed = true;
    const tool = createFileReadTool({ allowedPaths: [workspace], __testAfterFinalPathCheck: () => { allowed = false; } });
    const args = { file_path: join(workspace, "public.ts") };
    attachReadOnlyDelegationReadGuard(args, () => allowed);
    const result = await tool.execute(args);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("needle public");
  });

  it("refuses denied FileRead content even after a previous authorized read", async () => {
    const tool = createFileReadTool({ allowedPaths: [workspace] });
    const args = {
      file_path: join(workspace, "public.ts"),
      __agencSessionId: "readonly-search-session",
      __agencSessionIdSig: signSessionId("readonly-search-session"),
    };
    let allowed = true;
    attachReadOnlyDelegationReadGuard(args, () => allowed);
    expect((await tool.execute(args)).content).toContain("needle public");
    const snapshot = getSessionReadSnapshot("readonly-search-session", args.file_path);
    expect(snapshot?.content).toContain("needle public");
    allowed = false;
    const denied = await tool.execute(args);
    expect(denied.isError).toBe(true);
    expect(denied.content).not.toContain("needle public");
    expect(getSessionReadSnapshot("readonly-search-session", args.file_path)).toEqual(snapshot);
  });

  it("rechecks FileRead authority before exposing a captured dirty snapshot", async () => {
    const coordinator = workspaceMutationCoordinators.getOrCreate(workspace);
    const lease = coordinator.acquire({ workspaceRoot: workspace, editorInstanceId: "readonly-file-editor" });
    const content = "needle unsaved public\n";
    coordinator.sync({
      workspaceRoot: workspace, editorInstanceId: lease.editorInstanceId, leaseToken: lease.leaseToken, epoch: lease.epoch, sequence: 0,
      buffers: [{ path: join(workspace, "public.ts"), bufferHandle: 7, changedtick: 1, contentSha256: sha256(content), dirty: true, content }],
    });
    let allowed = true;
    const tool = createFileReadTool({ allowedPaths: [workspace], __testAfterFinalPathCheck: () => { allowed = false; } });
    const args = {
      file_path: join(workspace, "public.ts"),
      __agencSessionId: "readonly-search-session",
      __agencSessionIdSig: signSessionId("readonly-search-session"),
    };
    attachReadOnlyDelegationReadGuard(args, () => allowed);
    const result = await tool.execute(args);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("unsaved public");
    expect(getSessionReadSnapshot("readonly-search-session", args.file_path)).toBeUndefined();
  });

  it("rejects unauthorized FileRead bytes after final leaf replacement", async () => {
    const file = join(workspace, "public.ts");
    let exchanged = false;
    const tool = createFileReadTool({
      allowedPaths: [workspace],
      __testAfterFinalPathCheck: async () => {
        try {
          await rename(file, join(workspace, "held.ts"));
          await symlink(join(workspace, "secret.ts"), file);
          exchanged = true;
        } catch (error) {
          if (process.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
      },
    });
    const result = await tool.execute(guarded({ file_path: file }));
    expect(exchanged || process.platform === "win32").toBe(true);
    if (exchanged) expect(result.isError).toBe(true);
    else expect(result.content).toContain("needle public");
    expect(result.content).not.toContain("needle secret");
  });

  it("refuses delegated PDF helpers without a descriptor-safe input path", async () => {
    const file = join(workspace, "public.pdf");
    await writeFile(file, "%PDF-1.4\n");
    const result = await createFileReadTool({ allowedPaths: [workspace] }).execute(guarded({ file_path: file }));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("held file descriptor");
  });

  it.each(["content", "files_with_matches", "count"])("checks each Grep candidate before reading in %s mode", async output_mode => {
    const reads: string[] = [];
    const tool = bindExplicitDangerBoundary(createGrepTool({
      allowedPaths: [workspace],
      __testProtectedTaskObserver: event => { if (event.phase === "start") reads.push(event.source); },
    }));
    const result = await tool.execute(guarded({ pattern: "needle", path: workspace, output_mode }));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("public.ts");
    expect(result.content).not.toContain("secret");
    expect(result.content).not.toContain("nested");
    expect(reads).toEqual(["disk"]);
  });

  it.each(["root", "cwd", "absolute-pattern"])("checks Glob candidate paths with %s selection", async selection => {
    const tool = bindExplicitDangerBoundary(createGlobTool({ allowedPaths: [workspace] }));
    const args = selection === "cwd" ? { pattern: "**/*.ts", cwd: workspace }
      : selection === "absolute-pattern" ? { pattern: join(workspace, "**/*.ts") }
      : { pattern: "**/*.ts", path: workspace };
    const result = await tool.execute(guarded(args));
    expect(result.isError).not.toBe(true);
    expect(result.content).toBe("public.ts");
  });

  it("does not read denied ignore-file bytes while matching allowed content", async () => {
    await writeFile(join(workspace, ".ignore"), "public.ts\n");
    const tool = bindExplicitDangerBoundary(createGrepTool({ allowedPaths: [workspace] }));
    const result = await tool.execute(guarded({ pattern: "needle", path: workspace }));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("public.ts");
  });

  it("revalidates already-read Grep candidates before returning results", async () => {
    let allowed = true;
    const tool = bindExplicitDangerBoundary(createGrepTool({
      allowedPaths: [workspace],
      beforeAuthoritativeSnapshotValidation: () => { allowed = false; },
    }));
    const args = { pattern: "needle", path: join(workspace, "public.ts"), output_mode: "content" };
    attachReadOnlyDelegationReadGuard(args, () => allowed);
    const result = await tool.execute(args);
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("needle public");
  });

  it("bounds descriptor input bytes for constrained Grep", async () => {
    const file = join(workspace, "large.ts");
    await writeFile(file, "needle large\n");
    await truncate(file, MAX_GREP_DECODED_BYTES + 1);
    const tool = bindExplicitDangerBoundary(createGrepTool({ allowedPaths: [workspace] }));
    const result = await tool.execute(guarded({ pattern: "needle", path: file, output_mode: "content" }));
    expect(result.isError).toBe(true);
    expect(result.content).not.toContain("needle large");
  });

  it("does not search or copy denied authoritative dirty snapshots", async () => {
    const coordinator = workspaceMutationCoordinators.getOrCreate(workspace);
    const lease = coordinator.acquire({ workspaceRoot: workspace, editorInstanceId: "readonly-search-editor" });
    const content = "needle unsaved secret\n";
    coordinator.sync({
      workspaceRoot: workspace, editorInstanceId: lease.editorInstanceId, leaseToken: lease.leaseToken, epoch: lease.epoch, sequence: 0,
      buffers: [{ path: join(workspace, "secret.ts"), bufferHandle: 7, changedtick: 1, contentSha256: sha256(content), dirty: true, content }],
    });
    await coordinator.flushQuarantinePersistence();
    const sources: string[] = [];
    const tool = bindExplicitDangerBoundary(createGrepTool({
      allowedPaths: [workspace],
      __testProtectedTaskObserver: event => { if (event.phase === "start") sources.push(event.source); },
    }));
    const result = await tool.execute(guarded({ pattern: "needle", path: workspace, output_mode: "content" }));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("public.ts");
    expect(result.content).not.toContain("secret");
    expect(sources).toEqual(["disk"]);
    const capture = coordinator.authoritativeDirtySnapshotsUnderIdentity(workspace, path => !path.endsWith("secret.ts"));
    expect(capture).toEqual([]);
  });

  it.each(["cwd", "absolute-pattern"])("refuses a denied Glob root selected by %s", async selection => {
    const tool = bindExplicitDangerBoundary(createGlobTool({ allowedPaths: [workspace] }));
    const args = selection === "cwd" ? { pattern: "**/*.ts", cwd: join(workspace, "private") }
      : { pattern: join(workspace, "private", "**/*.ts") };
    const result = await tool.execute(guarded(args));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Access denied");
  });

  it.each(["content", "files_with_matches", "count"])("retains authorized pagination in %s mode", async output_mode => {
    await writeFile(join(workspace, "another.ts"), "needle another\n");
    const tool = bindExplicitDangerBoundary(createGrepTool({ allowedPaths: [workspace] }));
    const result = await tool.execute(guarded({ pattern: "needle", path: workspace, output_mode, offset: 1, head_limit: 1, glob: "*.ts" }));
    expect(result.isError).not.toBe(true);
    expect(result.content).toContain("public.ts");
    expect(result.content).not.toContain("another.ts");
  });
});
