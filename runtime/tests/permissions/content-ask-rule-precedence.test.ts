/**
 * Content-specific `ask` rules must outrank the working-directory and mode
 * auto-allows in path validation, and a matched ask must not be converted
 * into an allow under `bypassPermissions` (#2125).
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTempWorkspaceFixture } from "../helpers/temp-workspace.js";
import type { Session } from "../session/session.js";
import { createFileReadTool } from "../tools/system/file-read.js";
import { createFileWriteTool } from "../tools/system/file-write.js";
import {
  attachContextDefaults,
  hasPermissionsToUseTool,
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

const workspaces = createTempWorkspaceFixture("agenc-ask-precedence-");

describe("content-specific ask rules outrank mode auto-allows (#2125)", () => {
  let root = "";
  let outside = "";

  beforeEach(async () => {
    [root, outside] = await Promise.all([
      workspaces.create(),
      workspaces.create(),
    ]);
  });

  afterEach(() => workspaces.cleanup());

  const ctx = (
    overrides: Parameters<typeof createEmptyToolPermissionContext>[0] = {},
  ): ToolPermissionContext => createEmptyToolPermissionContext(overrides);

  const withRule = (
    context: ToolPermissionContext,
    behavior: "allow" | "ask" | "deny",
    toolName: string,
    ruleContent: string,
    destination: RuleDestination = "session",
  ): ToolPermissionContext =>
    applyPermissionUpdate(context, {
      type: "addRules",
      destination,
      behavior,
      rules: [{ toolName, ruleContent }],
    });

  const checkPath = (
    toolName: string,
    path: string,
    context: ToolPermissionContext,
    operationType: "read" | "write",
  ): PermissionResult =>
    checkToolPathPermission({
      toolName,
      input: { file_path: path },
      path,
      cwd: root,
      context,
      operationType,
    });

  function expectRuleAsk(result: PermissionResult): void {
    expect(result.behavior).toBe("ask");
    expect(result.decisionReason).toMatchObject({
      type: "rule",
      rule: { ruleBehavior: "ask" },
    });
  }

  function expectValidatedAsk(
    path: string,
    context: ToolPermissionContext,
    operationType: "read" | "write",
  ): void {
    const validated = validatePath(path, root, context, operationType);
    expect(validated.allowed).toBe(false);
    expect(validated.decisionReason).toMatchObject({
      type: "rule",
      rule: { ruleBehavior: "ask" },
    });
  }

  async function expectToolKeepsAsk(opts: {
    toolName: "FileRead" | "Write";
    target: string;
    input: Record<string, unknown>;
    createTool: () => { name: string } & Record<string, unknown>;
  }): Promise<void> {
    const permissionContext = withRule(
      ctx({ mode: "bypassPermissions" }),
      "ask",
      opts.toolName,
      opts.target,
    );
    const decision = await hasPermissionsToUseTool(
      opts.createTool() as never,
      opts.input,
      attachContextDefaults({
        getAppState: () => ({
          toolPermissionContext: permissionContext,
          denialTracking: { consecutiveDenials: 0, totalDenials: 0 },
          autoModeActive: false,
        }),
        session: {} as Session,
      } as ToolEvaluatorContext),
    );
    expectRuleAsk(decision);
  }

  describe("workspace reads", () => {
    test.each(MODES)(
      "an exact FileRead ask rule forces confirmation in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        const context = withRule(ctx({ mode }), "ask", "FileRead", target);
        expectValidatedAsk(target, context, "read");
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
        expectValidatedAsk(target, context, "write");
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
      const result = validatePath(
        join(root, "src", "app.ts"),
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
    test.each([
      { toolName: "FileRead" as const, file: "hosts", operation: "read" as const },
      { toolName: "Write" as const, file: "nginx.conf", operation: "write" as const },
    ])(
      "an exact $toolName ask rule outside the workspace still asks",
      async ({ toolName, file, operation }) => {
        const target = join(outside, file);
        if (operation === "read") {
          await writeFile(target, "127.0.0.1 localhost", "utf8");
        }
        expectRuleAsk(
          checkPath(
            toolName,
            target,
            withRule(ctx({ mode: "bypassPermissions" }), "ask", toolName, target),
            operation,
          ),
        );
      },
    );

    test("paths the ask rule does not name keep the bypass auto-allow", async () => {
      const other = join(outside, "resolv.conf");
      await writeFile(other, "nameserver 1.1.1.1", "utf8");
      const result = checkPath(
        "FileRead",
        other,
        withRule(
          ctx({ mode: "bypassPermissions" }),
          "ask",
          "FileRead",
          join(outside, "hosts"),
        ),
        "read",
      );
      expect(result.behavior).toBe("allow");
      expect(result.decisionReason).toEqual({
        type: "mode",
        mode: "bypassPermissions",
      });
    });

    test.each([
      {
        toolName: "FileRead" as const,
        relative: "package.json",
        createTool: (allowedPaths: string[]) => createFileReadTool({ allowedPaths }),
        input: (target: string) => ({ file_path: target, cwd: root }),
        seed: true,
      },
      {
        toolName: "Write" as const,
        relative: join("src", "app.ts"),
        createTool: (allowedPaths: string[]) => createFileWriteTool({ allowedPaths }),
        input: (target: string) => ({ file_path: target, content: "x", cwd: root }),
        seed: false,
      },
    ])(
      "the $toolName tool surfaces the rule ask so the evaluator keeps it",
      async ({ toolName, relative, createTool, input, seed }) => {
        const target = join(root, relative);
        if (seed) await writeFile(target, "{}", "utf8");
        await expectToolKeepsAsk({
          toolName,
          target,
          input: input(target),
          createTool: () => createTool([root]),
        });
      },
    );
  });

  describe("precedence among rules and safety gates", () => {
    test.each(MODES)(
      "deny outranks ask on the same path in %s mode",
      async (mode) => {
        const target = join(root, "package.json");
        await writeFile(target, "{}", "utf8");
        const context = withRule(
          withRule(ctx({ mode }), "ask", "FileRead", target),
          "deny",
          "FileRead",
          target,
        );
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
        expectRuleAsk(
          checkPath(
            "FileRead",
            target,
            withRule(
              withRule(ctx({ mode }), "allow", "FileRead", target),
              "ask",
              "FileRead",
              target,
            ),
            "read",
          ),
        );
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
        const result = checkPath(
          "FileRead",
          target,
          withRule(ctx({ mode }), "ask", "FileRead", target, "userSettings"),
          "read",
        );
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
        const result = checkPath(
          "Write",
          target,
          ctx({
            mode,
            alwaysAskRules: {
              policySettings: [`Write(${target.replace(/\\/g, "/")})`],
            },
          }),
          "write",
        );
        expectRuleAsk(result);
        expect(result.decisionReason).toMatchObject({
          rule: { source: "policySettings" },
        });
      },
    );

    test("a policy ask outranks a user allow for the same path", async () => {
      const target = join(root, "package.json");
      await writeFile(target, "{}", "utf8");
      const result = checkPath(
        "FileRead",
        target,
        withRule(
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
        ),
        "read",
      );
      expectRuleAsk(result);
      expect(result.decisionReason).toMatchObject({
        rule: { source: "policySettings" },
      });
    });
  });
});
