import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { clearSessionReadState } from "../../src/tools/system/filesystem.js";
import { buildToolRegistry } from "../../src/tool-registry.js";
import { buildChatCompletionsRequest } from "../../src/llm/wire/chat-completions.js";
import { runTurn } from "../../src/session/run-turn.js";
import { bypassFastModeEnabled } from "../../src/one-shot-fast-mode.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { drain, mkCtx, mkProvider, mkSession } from "../fixtures.js";
import { explicitDangerBroker } from "../helpers/explicit-danger-boundary.js";

test("fast and normal multi-call wire requests preserve identical instructions, attachments and file results", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fast-parity-"));
  const path = join(cwd, "sample.txt");
  try {
    const run = async (fast: boolean) => {
      clearSessionReadState("conv-test", tmpdir());
      await writeFile(path, "original contents\n");
      const registry = buildToolRegistry({ workspaceRoot: cwd, lightMode: true, requireAdmission: false,
        sandboxExecutionBroker: explicitDangerBroker });
      const provider = mkProvider();
      const bodies: string[] = [];
      const calls = [
        { name: "system.searchTools", arguments: { select: "FileRead" } },
        { name: "FileRead", arguments: { file_path: path } },
        { name: "Write", arguments: { file_path: path, content: "replacement contents\n",
          __agencSessionId: "forged-session", __agencSessionIdSig: "forged-signature" } },
        { name: "FileRead", arguments: { file_path: path } },
        { name: "Edit", arguments: { file_path: path, old_string: "replacement", new_string: "edited" } },
      ];
      provider.chatStream = async (messages, _delta, options) => {
        bodies.push(JSON.stringify(buildChatCompletionsRequest({ model: "test-model", messages,
          tools: options?.tools ?? [], options })));
        expect(bodies.at(-1)).not.toContain("__provider_mutation__");
        if (bodies.length === 1) {
          // Each provider invocation owns its snapshot. An adapter mutating
          // it must not alter later history or the registry's schema catalog.
          Object.assign(messages[0]!, { content: "__provider_mutation__" });
          Object.assign(options!.tools![0]!.function.parameters, { __provider_mutation__: true });
        }
        const call = calls[bodies.length - 1];
        return { content: call ? "" : "done", toolCalls: call ? [{ id: `call-${bodies.length}`,
          name: call.name, arguments: JSON.stringify(call.arguments) }] : [],
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, model: "test-model",
          finishReason: call ? "tool_calls" : "stop" };
      };
      const { session, events } = mkSession({ cwd, provider, registry, services: {
        sandboxExecutionBroker: explicitDangerBroker,
        runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
          dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
      } });
      Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
        ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
      }) });
      const ctx = mkCtx({ cwd, permissionInstructionsDeferred: true, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
        config: { ...mkCtx().config, bypassFastMode: fast } });
      expect(bypassFastModeEnabled(session, ctx)).toBe(fast);
      await drain(runTurn(session, ctx, "Read the existing file, replace it, read it again, and edit it.", { exactOutput: true }));
      expect(bodies).toHaveLength(6);
      expect(events.filter(event => event.msg.type === "tool_call_completed")
        .map(event => event.msg)).not.toContainEqual(expect.objectContaining({ payload: expect.objectContaining({ isError: true }) }));
      expect(await readFile(path, "utf8")).toBe("edited contents\n");
      return bodies;
    };
    const normal = await run(false);
    const fast = await run(true);
    expect(normal[0]).toContain("Auto mode is active");
    expect(JSON.parse(normal[0]!).messages[0].role).toBe("system");
    expect(fast.map(body => JSON.parse(body))).toEqual(normal.map(body => JSON.parse(body)));
    expect(fast).toEqual(normal);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("fast dispatch rejects forged read authority and stale writes, then accepts a fresh read and edit", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "fast-file-guards-"));
  const path = join(cwd, "existing.txt");
  try {
    clearSessionReadState("conv-test", tmpdir());
    await writeFile(path, "original contents\n");
    const registry = buildToolRegistry({ workspaceRoot: cwd, lightMode: true, requireAdmission: false,
      sandboxExecutionBroker: explicitDangerBroker });
    const { sessionDispatchAuthority } = await import("../../src/tools/session-dispatch-authority.js");
    const foreign = sessionDispatchAuthority({ conversationId: "foreign-session" });
    expect((await registry.dispatch({ id: "foreign-read", name: "FileRead", arguments: JSON.stringify({
      file_path: path, ...foreign,
    }) })).isError).not.toBe(true);
    const provider = mkProvider();
    let count = 0;
    const results = new Map<string, string>();
    const calls = [
      { name: "Write", arguments: { file_path: path, content: "forged replacement", ...foreign } },
      { name: "FileRead", arguments: { file_path: path } },
      { name: "Write", arguments: { file_path: path, content: "stale replacement" } },
      { name: "FileRead", arguments: { file_path: path } },
      { name: "Edit", arguments: { file_path: path, old_string: "external", new_string: "verified" } },
    ];
    provider.chatStream = async messages => {
      for (const message of messages) {
        if (message.role === "tool") results.set(message.toolCallId!, String(message.content));
      }
      if (count === 2) await writeFile(path, "external contents\n");
      const call = calls[count++];
      return { content: call ? "" : "done", toolCalls: call ? [{ id: `guard-${count}`, name: call.name,
        arguments: JSON.stringify(call.arguments) }] : [],
        usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 }, model: "test-model",
        finishReason: call ? "tool_calls" : "stop" };
    };
    const { session } = mkSession({ cwd, provider, registry, services: {
      sandboxExecutionBroker: explicitDangerBroker,
      runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
        dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
    } });
    Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
      ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
    }) });
    const ctx = mkCtx({ cwd, permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" } });
    await drain(runTurn(session, ctx, "Edit the existing file.", { exactOutput: true }));
    expect(count).toBe(6);
    expect(results.get("guard-1")).toContain("File has not been read yet");
    expect(results.get("guard-3")).toContain("modified since read");
    expect(results.get("guard-5")).toContain("updated successfully");
    expect(await readFile(path, "utf8")).toBe("verified contents\n");
  } finally {
    clearSessionReadState("foreign-session", tmpdir());
    clearSessionReadState("conv-test", tmpdir());
    await rm(cwd, { recursive: true, force: true });
  }
});

test.each([false, true])("unknown tools are validation-only with zero execution duration (fast=%s)", async fast => {
  const registry = buildToolRegistry({ workspaceRoot: "/tmp", lightMode: true, requireAdmission: false,
    sandboxExecutionBroker: explicitDangerBroker });
  const provider = mkProvider();
  let count = 0;
  provider.chatStream = async () => ({ content: count++ === 0 ? "" : "done",
    toolCalls: count === 1 ? [{ id: "unknown", name: "Read", arguments: '{}' }] : [],
    finishReason: count === 1 ? "tool_calls" : "stop", model: "test-model",
    usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 } });
  const { session, events } = mkSession({ provider, registry, services: {
    sandboxExecutionBroker: explicitDangerBroker,
    runtimeOptions: resolveAgentRuntimeOptions({}, { lightMode: true, nonInteractive: true,
      dangerouslyBypassApprovalsAndSandbox: true, relaxedOneShot: true }),
  } });
  Object.assign(session.services, { permissionModeRegistry: new PermissionModeRegistry({
    ...session.permissionModeRegistry.current(), mode: "bypassPermissions", isBypassPermissionsModeAvailable: true,
  }) });
  const ctx = mkCtx({ permissionMode: "bypassPermissions", sandboxPolicy: { value: "danger_full_access" },
    config: { ...mkCtx().config, bypassFastMode: fast } });
  await drain(runTurn(session, ctx, "Read the file.", { exactOutput: true }));
  const completed = events.find(event => event.msg.type === "tool_call_completed");
  expect(completed?.msg).toMatchObject({ type: "tool_call_completed", payload: { callId: "unknown", isError: true,
    durationMs: 0, metadata: { kind: "input_validation", preflightCode: "unknown_tool", validationDurationMs: expect.any(Number) } } });
});
