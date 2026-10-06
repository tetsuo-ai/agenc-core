import { describe, expect, test } from "vitest";
import { isLightPrintRun, lightPrintMemoryContext } from "../../src/prompts/light-print.js";
import { DESKTOP_RICH_RENDERER_CLIENT } from "../../src/prompts/client-rendering.js";
import { lightMemoryContext } from "../../src/prompts/light-workflow.js";
import { getPermissionsSection, LIGHT_APPROVAL_NEVER, ROUTINE_NO_APPROVER_NOTE } from "../../src/prompts/permissions-prompt.js";
import { assembleSystemPromptSnapshot } from "../../src/prompts/system-prompt.js";
import { createEmptyToolPermissionContext } from "../../src/permissions/types.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { buildSamplingRequestContract } from "../../src/session/run-turn-sampling-request.js";
import { buildInitialTurnState } from "../../src/session/turn-state.js";
import { autoModeProducer } from "../../src/prompts/attachments/auto-mode.js";
import { attachmentsToMessages } from "../../src/prompts/attachments/messages.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import type { GetAttachmentsOptions } from "../../src/prompts/attachments/orchestrator.js";
import { mkCtx, mkSession } from "../fixtures.js";

const PRINT = { ...resolveAgentRuntimeOptions({}), lightMode: true, nonInteractive: true };
const CASES = [
  { name: "Light print", options: PRINT, env: {}, compact: true },
  { name: "Light interactive", options: { ...PRINT, nonInteractive: false }, env: {}, compact: false },
  { name: "Standard print", options: { ...PRINT, lightMode: false }, env: {}, compact: false },
  { name: "Desktop print", options: PRINT, env: { AGENC_AGENT_SDK_CLIENT_APP: DESKTOP_RICH_RENDERER_CLIENT }, compact: false },
  { name: "routine", options: { ...PRINT, routineRun: true }, env: {}, compact: false },
];
const AUTHORITY = { sandboxPolicy: "workspace_write" as const, networkSandboxPolicy: { enabled: false } };
const SAFETY = "Destructive actions and changes to shared or production systems still need explicit user confirmation. Never share secrets or post messages unless the user directed that exact action.";

function attachmentOpts(lightPrint: boolean): GetAttachmentsOptions {
  return {
    sessionKey: {}, lightMode: true, lightPrint, userInput: null, loadedTools: [], messages: [],
    permissionContext: createEmptyToolPermissionContext({ mode: "acceptEdits" }),
    cwd: "/workspace", subagentDepth: 0, signal: new AbortController().signal,
  };
}

describe("Light print prefix", () => {
  test.each(CASES)("$name uses captured session scope in direct and deferred assembly", async ({ options, env, compact }) => {
    expect(isLightPrintRun(options, env)).toBe(compact);
    const { session } = mkSession({ services: { runtimeOptions: options, providerEnvironment: env } });
    const context = createEmptyToolPermissionContext({ mode: "acceptEdits" });
    await session.permissionModeRegistry.update(context);
    const ctx = mkCtx({ cwd: "/workspace", sandboxPolicy: { value: AUTHORITY.sandboxPolicy }, networkSandboxPolicy: AUTHORITY.networkSandboxPolicy });
    const memoryPrompt = "MEMORY_PATHS\nOWNER_POLICY";
    const snapshot = await assembleSystemPromptSnapshot({ session, ctx, permissionContext: context, memoryPrompt });
    const expected = getPermissionsSection(context, AUTHORITY, { light: options.lightMode, lightPrint: compact });
    expect(snapshot.sections).toContain(expected);
    expect(snapshot.sections).toContain(compact ? `Workspace: /workspace. ${memoryPrompt}` : memoryPrompt);
    if (options.lightMode) expect(snapshot.sections.includes("Workspace: /workspace")).toBe(!compact);
    expect(snapshot.text).toContain("OWNER_POLICY");

    const deferred = { ...ctx, permissionInstructionsDeferred: true };
    const state = buildInitialTurnState(deferred, { role: "user", content: "Continue." }, { modelInstructions: "STABLE_BASE" });
    expect(buildSamplingRequestContract(state, session, deferred).baseInstructions).toBe(`STABLE_BASE\n\n${expected}`);
    const reminder = await autoModeProducer({ ...attachmentOpts(compact), lightMode: options.lightMode }, getAttachmentTrackingState({}));
    expect(reminder[0]).toMatchObject({ kind: "auto_mode", variant: compact ? "light-print" : options.lightMode ? "light" : "full" });
  });

  test("unset and simple sessions cannot select the print presentation", () => {
    expect(isLightPrintRun(undefined, undefined)).toBe(false);
    expect(isLightPrintRun({ ...PRINT, simpleMode: true }, {})).toBe(false);
  });

  test.each(["plan", "default", "acceptEdits", "bypassPermissions"] as const)("%s preserves effective sandbox and network facts without offering approval", mode => {
    const sandboxFacts = {
      workspace_write: "read files; write only cwd and writable_roots",
      read_only: "read files only",
      danger_full_access: "no filesystem sandbox",
      external_sandbox: "externally controlled; never widen or replace it",
    } as const;
    for (const sandboxPolicy of Object.keys(sandboxFacts) as (keyof typeof sandboxFacts)[]) {
      for (const enabled of [false, true]) {
        const context = createEmptyToolPermissionContext({ mode });
        const rendered = getPermissionsSection(context, { sandboxPolicy, networkSandboxPolicy: { enabled } }, { light: true, lightPrint: true });
        expect(rendered).toBe([
          `Permission mode: ${mode}. Sandbox ${sandboxPolicy.replaceAll("_", "-")}: ${sandboxFacts[sandboxPolicy]}; network ${enabled ? "enabled" : "restricted"}.`,
          "No approver: approval requests are denied. Do not bypass restrictions.",
          ...(mode === "bypassPermissions" ? [LIGHT_APPROVAL_NEVER] : []),
        ].join("\n"));
        expect(rendered).not.toContain("require_escalated");
      }
    }
  });

  test("unattended policy, no-approver routines and unmapped modes retain their original output", () => {
    for (const mode of ["unattended", "auto", "dontAsk", "bubble", "acceptEdits", "bypassPermissions"] as const) {
      const context = createEmptyToolPermissionContext({ mode, unattendedPolicy: { allowlist: ["FileRead"], denylist: ["Write"], noApprover: true, readOnly: true, workspaceRoots: ["/workspace"] } });
      const before = getPermissionsSection(context, AUTHORITY, { light: true });
      expect(getPermissionsSection(context, AUTHORITY, { light: true, lightPrint: true })).toBe(before);
      if (mode === "acceptEdits" || mode === "bypassPermissions") expect(before).toContain(ROUTINE_NO_APPROVER_NOTE);
    }
    expect(getPermissionsSection(null, AUTHORITY, { light: true, lightPrint: true })).toBeNull();
  });

  test("memory is reachable in one line, owner policy stays verbatim, and absent memory retains cwd", async () => {
    const extra = ["OWNER_POLICY\nKeep this exact." ];
    expect(lightPrintMemoryContext("/PROJECT/", "/GLOBAL/", extra)).toBe(
      "Memory: global /GLOBAL/; project /PROJECT/. Read on request; verify against files; ignore if asked.\nOWNER_POLICY\nKeep this exact.",
    );
    expect(lightPrintMemoryContext("/PROJECT/", "/GLOBAL/").length).toBeLessThan(lightMemoryContext("/PROJECT/", "/GLOBAL/").length);
    const { session } = mkSession({ services: { runtimeOptions: PRINT, providerEnvironment: {} } });
    const ctx = mkCtx({ cwd: "/workspace" });
    for (const memoryPrompt of [undefined, "", " \n"]) {
      const snapshot = await assembleSystemPromptSnapshot({ session, ctx, memoryPrompt });
      expect(snapshot.sections).toContain("Workspace: /workspace");
    }
    const before = await assembleSystemPromptSnapshot({ session, ctx });
    const after = await assembleSystemPromptSnapshot({ session, ctx, memoryPrompt: "MEMORY", permissionContext: createEmptyToolPermissionContext({ mode: "acceptEdits" }) });
    expect(after.staticPrefix).toBe(before.staticPrefix);
  });

  test("the exact safety sentences and marker survive rendering, throttling and re-entry", async () => {
    const opts = attachmentOpts(true);
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    const first = await autoModeProducer(opts, tracking);
    const messages = attachmentsToMessages(first);
    expect(messages[0]?.content).toBe(`<system-reminder>\nAuto mode is active. ${SAFETY}\n</system-reminder>`);
    const legacy = String(attachmentsToMessages([{ kind: "auto_mode", variant: "light" }])[0]?.content);
    expect(legacy).toContain(SAFETY);
    expect(String(messages[0]?.content).length).toBeLessThan(legacy.length - 70);
    expect(await autoModeProducer({ ...opts, messages }, tracking)).toEqual([]);
    const human = { role: "user" as const, content: "Continue." };
    expect(await autoModeProducer({ ...opts, messages: [...messages, ...Array(5).fill(human)] }, tracking)).toEqual([{ kind: "auto_mode", variant: "sparse" }]);
    const exit = attachmentsToMessages([{ kind: "auto_mode_exit" }]);
    expect(await autoModeProducer({ ...opts, messages: [...messages, ...exit] }, tracking)).toEqual([{ kind: "auto_mode", variant: "light-print" }]);
  });
});
