import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createFileEditTool } from "../tools/system/file-edit.js";
import { createFileReadTool } from "../tools/system/file-read.js";
import { createFileWriteTool } from "../tools/system/file-write.js";
import type { ToolEvaluatorContext } from "./evaluator.js";
import {
  checkToolPathPermission,
  expandTilde,
  formatDirectoryList,
  getGlobBaseDirectory,
  isDangerousRemovalPath,
  validatePath,
} from "./path-validation.js";
import { applyPermissionUpdate } from "./rules.js";
import {
  createEmptyToolPermissionContext,
  type ToolPermissionContext,
} from "./types.js";

describe("path-validation", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-path-validation-root-"));
    outside = await mkdtemp(join(tmpdir(), "agenc-path-validation-outside-"));
  });

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    if (outside) await rm(outside, { recursive: true, force: true });
    root = "";
    outside = "";
  });

  function ctx(
    overrides: Parameters<typeof createEmptyToolPermissionContext>[0] = {},
  ): ToolPermissionContext {
    return createEmptyToolPermissionContext(overrides);
  }

  test("formats short and long directory lists", () => {
    expect(formatDirectoryList(["/a", "/b"])).toBe("'/a', '/b'");
    expect(formatDirectoryList(["/a", "/b", "/c", "/d", "/e", "/f"])).toBe(
      "'/a', '/b', '/c', '/d', '/e', and 1 more",
    );
  });

  test("extracts glob base directories", () => {
    expect(getGlobBaseDirectory("src/**/*.ts")).toBe("src");
    expect(getGlobBaseDirectory("*.ts")).toBe(".");
    expect(getGlobBaseDirectory("/tmp/project/*.ts")).toBe("/tmp/project");
  });

  test("expands only safe tilde forms", () => {
    expect(expandTilde("~")).toBeTruthy();
    expect(expandTilde("~/x")).toContain("/x");
    expect(expandTilde("~root/.ssh")).toBe("~root/.ssh");
  });

  test("allows reads inside cwd without explicit rules", async () => {
    const target = join(root, "file.txt");
    await writeFile(target, "hello", "utf8");

    const result = validatePath(target, root, ctx(), "read");

    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(target);
  });

  test("asks for writes in cwd until acceptEdits is active", () => {
    const target = join(root, "new.txt");

    const defaultResult = validatePath(target, root, ctx(), "write");
    expect(defaultResult.allowed).toBe(false);
    expect(defaultResult.decisionReason?.type).toBe("workingDir");

    const acceptResult = validatePath(
      target,
      root,
      ctx({ mode: "acceptEdits" }),
      "write",
    );
    expect(acceptResult.allowed).toBe(true);
    expect(acceptResult.decisionReason).toEqual({
      type: "mode",
      mode: "acceptEdits",
    });
  });

  test("denies content-specific rules before working-directory allows", () => {
    const target = join(root, "denied.txt");
    const permissionContext = applyPermissionUpdate(ctx(), {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [{ toolName: "FileRead", ruleContent: target }],
    });

    const result = validatePath(target, root, permissionContext, "read");

    expect(result.allowed).toBe(false);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("allows write rules outside cwd when the path rule matches", () => {
    const target = join(outside, "allowed.txt");
    const permissionContext = applyPermissionUpdate(ctx(), {
      type: "addRules",
      destination: "session",
      behavior: "allow",
      rules: [{ toolName: "Write", ruleContent: `${outside}/**` }],
    });

    const result = validatePath(target, root, permissionContext, "write");

    expect(result.allowed).toBe(true);
    expect(result.decisionReason?.type).toBe("rule");
  });

  test("blocks expansion syntax before filesystem resolution", () => {
    const result = validatePath("$HOME/.ssh/id_rsa", root, ctx(), "read");

    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe("$HOME/.ssh/id_rsa");
    expect(result.decisionReason).toEqual({
      type: "other",
      reason: "Shell expansion syntax in paths requires manual approval",
    });
  });

  test("blocks write globs but permits read glob base validation", () => {
    const writeResult = validatePath("src/*.ts", root, ctx(), "write");
    expect(writeResult.allowed).toBe(false);
    expect(writeResult.decisionReason?.type).toBe("other");

    const readResult = validatePath("src/*.ts", root, ctx(), "read");
    expect(readResult.allowed).toBe(true);
    expect(readResult.resolvedPath).toBe(join(root, "src"));
  });

  test("marks root, home, root children, and drive roots as dangerous removal paths", () => {
    expect(isDangerousRemovalPath("/")).toBe(true);
    expect(isDangerousRemovalPath("/tmp")).toBe(true);
    expect(isDangerousRemovalPath(join(root, "child"))).toBe(false);
    expect(isDangerousRemovalPath("C:/")).toBe(true);
    expect(isDangerousRemovalPath("C:/Windows")).toBe(true);
  });

  test("checkToolPathPermission emits deny for deny-rule matches", () => {
    const target = join(root, "denied.txt");
    const permissionContext = applyPermissionUpdate(ctx(), {
      type: "addRules",
      destination: "session",
      behavior: "deny",
      rules: [{ toolName: "Write", ruleContent: target }],
    });

    const result = checkToolPathPermission({
      toolName: "Write",
      input: { file_path: target },
      path: target,
      cwd: root,
      context: permissionContext,
      operationType: "write",
    });

    expect(result.behavior).toBe("deny");
    if (result.behavior === "deny") {
      expect(result.decisionReason.type).toBe("rule");
    }
  });

  test("Write checkPermissions uses path validation before execution", () => {
    const tool = createFileWriteTool({ allowedPaths: [root] });
    const target = join(outside, "denied.txt");
    const evaluatorContext = {
      getAppState() {
        return {
          toolPermissionContext: ctx(),
          denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
          autoModeActive: false,
        };
      },
      session: {},
    } as ToolEvaluatorContext;

    const result = tool.checkPermissions?.(
      { file_path: target, content: "x", cwd: root },
      evaluatorContext,
    );

    expect(result).toMatchObject({
      behavior: "ask",
      blockedPath: target,
    });
  });

  test("FileRead checkPermissions uses path validation before execution", () => {
    const tool = createFileReadTool({ allowedPaths: [root] });
    const target = join(outside, "outside.txt");
    const evaluatorContext = {
      getAppState() {
        return {
          toolPermissionContext: ctx(),
          denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
          autoModeActive: false,
        };
      },
      session: {},
    } as ToolEvaluatorContext;

    const result = tool.checkPermissions?.(
      { file_path: target, cwd: root },
      evaluatorContext,
    );

    expect(result).toMatchObject({
      behavior: "ask",
      blockedPath: target,
    });
  });

  test("Edit checkPermissions uses path validation before execution", () => {
    const tool = createFileEditTool({ allowedPaths: [root] });
    const target = join(outside, "outside.txt");
    const evaluatorContext = {
      getAppState() {
        return {
          toolPermissionContext: ctx(),
          denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
          autoModeActive: false,
        };
      },
      session: {},
    } as ToolEvaluatorContext;

    const result = tool.checkPermissions?.(
      { file_path: target, old_string: "", new_string: "x", cwd: root },
      evaluatorContext,
    );

    expect(result).toMatchObject({
      behavior: "ask",
      blockedPath: target,
    });
  });

  // Regression: audit #3 — bypassPermissions / --yolo must not short-circuit
  // to allow before path-specific Deny rules and write-safety gates run.
  describe("checkToolPathPermission honors deny + safety gates under bypassPermissions", () => {
    test("explicit Deny(Write) rule still denies under bypassPermissions", () => {
      const target = join(root, "denied.txt");
      const permissionContext = applyPermissionUpdate(
        ctx({ mode: "bypassPermissions" }),
        {
          type: "addRules",
          destination: "session",
          behavior: "deny",
          rules: [{ toolName: "Write", ruleContent: target }],
        },
      );

      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: permissionContext,
        operationType: "write",
      });

      expect(result.behavior).toBe("deny");
      if (result.behavior === "deny") {
        expect(result.decisionReason.type).toBe("rule");
      }
    });

    test("explicit Deny(Read) rule still denies under bypassPermissions", () => {
      const target = join(root, "secret.txt");
      const permissionContext = applyPermissionUpdate(
        ctx({ mode: "bypassPermissions" }),
        {
          type: "addRules",
          destination: "session",
          behavior: "deny",
          rules: [{ toolName: "FileRead", ruleContent: target }],
        },
      );

      const result = checkToolPathPermission({
        toolName: "FileRead",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: permissionContext,
        operationType: "read",
      });

      expect(result.behavior).toBe("deny");
    });

    test(".git protected path is not auto-allowed under bypassPermissions", () => {
      const target = join(root, ".git", "config");

      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: ctx({ mode: "bypassPermissions" }),
        operationType: "write",
      });

      expect(result.behavior).not.toBe("allow");
      expect(result.decisionReason?.type).toBe("safetyCheck");
    });

    test(".agenc protected path is not auto-allowed under bypassPermissions", () => {
      const target = join(root, ".agenc", "settings.json");

      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: ctx({ mode: "bypassPermissions" }),
        operationType: "write",
      });

      expect(result.behavior).not.toBe("allow");
      expect(result.decisionReason?.type).toBe("safetyCheck");
    });

    test("with no deny rule or safety violation, bypassPermissions auto-allows", () => {
      // Outside cwd with no rule would normally ask; bypass auto-allows.
      const target = join(outside, "anywhere.txt");

      const result = checkToolPathPermission({
        toolName: "Write",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: ctx({ mode: "bypassPermissions" }),
        operationType: "write",
      });

      expect(result.behavior).toBe("allow");
      expect(result.decisionReason).toEqual({
        type: "mode",
        mode: "bypassPermissions",
      });
    });

    test("reads outside cwd are auto-allowed under bypassPermissions", () => {
      const target = join(outside, "read-me.txt");

      const result = checkToolPathPermission({
        toolName: "FileRead",
        input: { file_path: target },
        path: target,
        cwd: root,
        context: ctx({ mode: "bypassPermissions" }),
        operationType: "read",
      });

      expect(result.behavior).toBe("allow");
      expect(result.decisionReason).toEqual({
        type: "mode",
        mode: "bypassPermissions",
      });
    });
  });
});
