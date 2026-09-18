/**
 * Content-specific `ask` rules must outrank the working-directory and mode
 * auto-allows in path validation, and a matched ask must not be converted
 * into an allow under `bypassPermissions` (#2125).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { Session } from "../session/session.js";
import { createFileReadTool } from "../tools/system/file-read.js";
import { createFileWriteTool } from "../tools/system/file-write.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
  type AppStateSnapshot,
  type ToolEvaluatorContext,
} from "./evaluator.js";
import { checkToolPathPermission, validatePath } from "./path-validation.js";
import { applyPermissionUpdate } from "./permission-updates.js";
import {
  createEmptyToolPermissionContext,
  type PermissionMode,
  type PermissionResult,
  type ToolPermissionContext,
} from "./types.js";

type RuleDestination =
  | "userSettings"
  | "projectSettings"
  | "localSettings"
  | "session"
  | "cliArg";

const MODES: readonly PermissionMode[] = [
  "default",
  "acceptEdits",
  "auto",
  "bypassPermissions",
];

describe("content-specific ask rules outrank mode auto-allows (#2125)", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agenc-ask-precedence-root-"));
    outside = await mkdtemp(join(tmpdir(), "agenc-ask-precedence-outside-"));
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

  function withRule(
    context: ToolPermissionContext,
    behavior: "allow" | "ask" | "deny",
    toolName: string,
    ruleContent: string,
    destination: RuleDestination = "session",
  ): ToolPermissionContext {
    return applyPermissionUpdate(context, {
      type: "addRules",
      destination,
      behavior,
      rules: [{ toolName, ruleContent }],
    });
  }

  function checkPath(
    toolName: string,
    path: string,
    context: ToolPermissionContext,
    operationType: "read" | "write",
  ): PermissionResult {
    return checkToolPathPermission({
      toolName,
      input: { file_path: path },
      path,
      cwd: root,
      context,
      operationType,
    });
  }

  function expectRuleAsk(result: PermissionResult): void {
    expect(result.behavior).toBe("ask");
    expect(result.decisionReason).toMatchObject({
      type: "rule",
      rule: { ruleBehavior: "ask" },
    });
  }

  describe("workspace reads", () => {
    test.each(MODES)(
      "an exact FileRead ask rule forces confirmation in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        const context = withRule(ctx({ mode }), "ask", "FileRead", target);

        const validated = validatePath(target, root, context, "read");
        expect(validated.allowed).toBe(false);
        expect(validated.decisionReason).toMatchObject({
          type: "rule",
          rule: { ruleBehavior: "ask" },
        });

        expectRuleAsk(checkPath("FileRead", target, context, "read"));
      },
    );

    test.each(MODES)(
      "a glob FileRead ask rule forces confirmation in %s mode",
      async (mode) => {
        const target = join(root, "config", "prod.env");
        await mkdir(join(root, "config"), { recursive: true });
        await writeFile(target, "SECRET=1", "utf8");
        const context = withRule(ctx({ mode }), "ask", "FileRead", "**/*.env");

        expectRuleAsk(checkPath("FileRead", target, context, "read"));
        // A sibling the glob does not name keeps the mode auto-allow.
        const other = join(root, "config", "README.md");
        await writeFile(other, "docs", "utf8");
        expect(checkPath("FileRead", other, context, "read").behavior).toBe(
          "allow",
        );
      },
    );

    test("a subtree FileRead ask rule covers a read glob rooted in it", async () => {
      await mkdir(join(root, "secrets"), { recursive: true });
      const context = withRule(
        ctx(),
        "ask",
        "FileRead",
        `${root}/secrets/**`.replace(/\\/g, "/"),
      );

      const result = validatePath(
        join(root, "secrets", "*.pem"),
        root,
        context,
        "read",
      );
      expect(result.allowed).toBe(false);
      expect(result.decisionReason?.type).toBe("rule");
    });

    test("without an ask rule the workspace read keeps the mode auto-allow", async () => {
      const target = join(root, "package.json");
      await writeFile(target, "{}", "utf8");

      const result = validatePath(target, root, ctx(), "read");
      expect(result.allowed).toBe(true);
      expect(result.decisionReason).toEqual({ type: "mode", mode: "default" });
    });
  });

  describe("workspace writes", () => {
    test.each(MODES)(
      "an exact Write ask rule forces confirmation in %s mode",
      (mode) => {
        const target = join(root, "src", "app.ts");
        const context = withRule(ctx({ mode }), "ask", "Write", target);

        const validated = validatePath(target, root, context, "write");
        expect(validated.allowed).toBe(false);
        expect(validated.decisionReason).toMatchObject({
          type: "rule",
          rule: { ruleBehavior: "ask" },
        });

        expectRuleAsk(checkPath("Write", target, context, "write"));
      },
    );

    test("a glob Edit ask rule forces confirmation for an acceptEdits write", () => {
      const target = join(root, "migrations", "0001_init.sql");
      const context = withRule(
        ctx({ mode: "acceptEdits" }),
        "ask",
        "Edit",
        `${root}/migrations/**`.replace(/\\/g, "/"),
      );

      expectRuleAsk(checkPath("Edit", target, context, "write"));
      expectRuleAsk(checkPath("Write", target, context, "write"));
    });

    test("without an ask rule an acceptEdits write keeps the mode auto-allow", () => {
      const target = join(root, "src", "app.ts");

      const result = validatePath(
        target,
        root,
        ctx({ mode: "acceptEdits" }),
        "write",
      );
      expect(result.allowed).toBe(true);
      expect(result.decisionReason).toEqual({
        type: "mode",
        mode: "acceptEdits",
      });
    });
  });

  describe("bypassPermissions does not convert a rule ask into an allow", () => {
    test("an exact FileRead ask rule outside the workspace still asks", async () => {
      const target = join(outside, "hosts");
      await writeFile(target, "127.0.0.1 localhost", "utf8");
      const context = withRule(
        ctx({ mode: "bypassPermissions" }),
        "ask",
        "FileRead",
        target,
      );

      expectRuleAsk(checkPath("FileRead", target, context, "read"));
    });

    test("an exact Write ask rule outside the workspace still asks", () => {
      const target = join(outside, "nginx.conf");
      const context = withRule(
        ctx({ mode: "bypassPermissions" }),
        "ask",
        "Write",
        target,
      );

      expectRuleAsk(checkPath("Write", target, context, "write"));
    });

    test("paths the ask rule does not name keep the bypass auto-allow", async () => {
      const asked = join(outside, "hosts");
      const other = join(outside, "resolv.conf");
      await writeFile(other, "nameserver 1.1.1.1", "utf8");
      const context = withRule(
        ctx({ mode: "bypassPermissions" }),
        "ask",
        "FileRead",
        asked,
      );

      const result = checkPath("FileRead", other, context, "read");
      expect(result.behavior).toBe("allow");
      expect(result.decisionReason).toEqual({
        type: "mode",
        mode: "bypassPermissions",
      });
    });

    test("the FileRead tool surfaces the rule ask so the evaluator keeps it", async () => {
      const target = join(root, "package.json");
      await writeFile(target, "{}", "utf8");
      const tool = createFileReadTool({ allowedPaths: [root] });
      const permissionContext = withRule(
        ctx({ mode: "bypassPermissions" }),
        "ask",
        "FileRead",
        target,
      );
      const state: AppStateSnapshot = {
        toolPermissionContext: permissionContext,
        denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
        autoModeActive: false,
      };
      const context = attachContextDefaults({
        getAppState: () => state,
        session: {} as Session,
      } as ToolEvaluatorContext);

      const decision = await hasPermissionsToUseTool(
        tool,
        { file_path: target, cwd: root },
        context,
      );

      expectRuleAsk(decision);
    });

    test("the Write tool surfaces the rule ask so the evaluator keeps it", async () => {
      const target = join(root, "src", "app.ts");
      const tool = createFileWriteTool({ allowedPaths: [root] });
      const permissionContext = withRule(
        ctx({ mode: "bypassPermissions" }),
        "ask",
        "Write",
        target,
      );
      const state: AppStateSnapshot = {
        toolPermissionContext: permissionContext,
        denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
        autoModeActive: false,
      };
      const context = attachContextDefaults({
        getAppState: () => state,
        session: {} as Session,
      } as ToolEvaluatorContext);

      const decision = await hasPermissionsToUseTool(
        tool,
        { file_path: target, content: "x", cwd: root },
        context,
      );

      expectRuleAsk(decision);
    });
  });

  describe("precedence among rules and safety gates", () => {
    test.each(MODES)(
      "deny outranks ask on the same path in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        let context = withRule(ctx({ mode }), "ask", "FileRead", target);
        context = withRule(context, "deny", "FileRead", target);

        const result = checkPath("FileRead", target, context, "read");
        expect(result.behavior).toBe("deny");
        expect(result.decisionReason).toMatchObject({
          type: "rule",
          rule: { ruleBehavior: "deny" },
        });
      },
    );

    test.each(MODES)(
      "ask outranks a conflicting allow rule in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        let context = withRule(ctx({ mode }), "allow", "FileRead", target);
        context = withRule(context, "ask", "FileRead", target);

        expectRuleAsk(checkPath("FileRead", target, context, "read"));
      },
    );

    test.each(MODES)(
      "the protected-path safety check stays fail-closed under an ask rule in %s mode",
      (mode) => {
        const target = join(root, ".git", "config");
        const context = withRule(ctx({ mode }), "ask", "Write", target);

        const validated = validatePath(target, root, context, "write");
        expect(validated.allowed).toBe(false);
        expect(validated.decisionReason?.type).toBe("safetyCheck");

        const result = checkPath("Write", target, context, "write");
        expect(result.behavior).not.toBe("allow");
        expect(result.decisionReason?.type).toBe("safetyCheck");
      },
    );
  });

  describe("rules from settings sources", () => {
    test.each(MODES)(
      "a user-settings FileRead ask rule forces confirmation in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        const context = withRule(
          ctx({ mode }),
          "ask",
          "FileRead",
          target,
          "userSettings",
        );

        const result = checkPath("FileRead", target, context, "read");
        expectRuleAsk(result);
        expect(result.decisionReason).toMatchObject({
          rule: { source: "userSettings" },
        });
      },
    );

    test.each(MODES)(
      "a policy-settings Write ask rule forces confirmation in %s mode",
      (mode) => {
        const target = join(root, "src", "app.ts");
        const context = ctx({
          mode,
          alwaysAskRules: {
            policySettings: [`Write(${target.replace(/\\/g, "/")})`],
          },
        });

        const result = checkPath("Write", target, context, "write");
        expectRuleAsk(result);
        expect(result.decisionReason).toMatchObject({
          rule: { source: "policySettings" },
        });
      },
    );

    test("a policy ask outranks a user allow for the same path", async () => {
      const target = join(root, "package.json");
      await writeFile(target, "{}", "utf8");
      const context = withRule(
        ctx({
          mode: "bypassPermissions",
          alwaysAskRules: {
            policySettings: [`FileRead(${target.replace(/\\/g, "/")})`],
          },
        }),
        "allow",
        "FileRead",
        target,
        "userSettings",
      );

      const result = checkPath("FileRead", target, context, "read");
      expectRuleAsk(result);
      expect(result.decisionReason).toMatchObject({
        rule: { source: "policySettings" },
      });
    });
  });
});
