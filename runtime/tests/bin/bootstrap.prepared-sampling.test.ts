import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bootstrapLocalRuntimeSession, type BootstrapLocalRuntimeSessionOptions } from "../../src/bin/bootstrap.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import * as providerFactory from "../../src/llm/provider.js";
import type { LLMProvider, LLMResponse } from "../../src/llm/types.js";
import { getAttachmentTrackingState } from "../../src/session/attachment-state.js";
import type { PreparedSamplingEvidence, PreparedSamplingValidator } from "../../src/session/prepared-sampling-evidence.js";
import { Session } from "../../src/session/session.js";
import { trustProjectSync } from "../../src/permissions/trust/project-trust.js";
import * as shell from "../../src/utils/Shell.js";

const cleanups: Array<() => void | Promise<void>> = [];
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(accept => { resolve = accept; });
  return { promise, resolve };
}
afterEach(async () => {
  const errors: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) {
    try { await cleanup(); } catch (error) { errors.push(error); }
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (errors.length) throw new AggregateError(errors, "prepared bootstrap cleanup failed");
});

describe("canonical bootstrap prepared-sampling authority", () => {
  it.each(["accept", "reject", "absent"] as const)("%s uses actual Session and admission, not a replacement bootstrap", async mode => {
    const root = await mkdtemp(join(tmpdir(), "bootstrap-prepared-"));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const home = join(root, "home"), cwd = join(root, "workspace");
    await mkdir(home); await mkdir(join(cwd, ".git"), { recursive: true });
    const config = join(home, "fixture.toml");
    await writeFile(config, 'config_version = 2\nmodel = "gpt-4.1-mini"\nmodel_provider = "openai"\n');
    trustProjectSync({ agencHome: home, cwd, env: { HOME: home } });
    const kernel = new ExecutionAdmissionKernel({ agencHome: home, ownerId: "prepared-bootstrap-test", ownerPid: process.pid });
    cleanups.push(() => kernel.close());
    const runId = "prepared-bootstrap-run";
    const journal = () => kernel.listJournal({ cwd, runId });
    const reports: PreparedSamplingEvidence[] = [];
    const chat = vi.fn<LLMProvider["chat"]>(async (_messages, options): Promise<LLMResponse> => {
      const dispatched = journal().filter(row => row.event === "dispatched");
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]?.details?.managedRequestId).toBe(options?.managedRequestId);
      expect(options?.managedRequestId).toMatch(/^[0-9a-f-]{36}$/);
      if (mode !== "absent") expect(options?.managedRequestId).toBe(reports[0]?.managedRequestId);
      return { content: "Finished.", toolCalls: [], model: "gpt-4.1-mini", finishReason: "stop",
        usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12,
          availability: "reported", provenance: "provider", cachedInputTokens: 0,
          reasoningOutputTokens: 0, webSearchRequests: 0 } };
    });
    const provider: LLMProvider = {
      name: "openai", chat,
      chatStream: (messages, _onChunk, options) => chat(messages, options),
      healthCheck: async () => true,
    };
    vi.spyOn(providerFactory, "createProvider").mockReturnValue(provider);
    // External MCP and network work are not needed for this constructor/turn seam.
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
    const network = vi.fn<typeof fetch>().mockRejectedValue(new Error("offline fixture"));
    vi.stubGlobal("fetch", network);
    const selected = vi.fn<PreparedSamplingValidator>(report => {
      expect(chat).not.toHaveBeenCalled();
      expect(journal()).toHaveLength(0);
      expect(report.inventory).toBe("complete");
      reports.push(report);
      if (mode === "reject") throw new Error("fixture semantic refusal");
      return undefined;
    });
    const swapped = vi.fn<PreparedSamplingValidator>(() => { throw new Error("replacement must not run"); });
    const entered = deferred<void>();
    const release = deferred<string>();
    vi.spyOn(shell, "findSuitableShell").mockImplementation(async () => { entered.resolve(); return release.promise; });
    const options: BootstrapLocalRuntimeSessionOptions = {
      apiKey: "synthetic-unused", cwd, conversationId: runId,
      argv: ["node", "agenc", "--config", config, "--light"],
      env: { PATH: process.env.PATH, HOME: home, AGENC_HOME: home, AGENC_WORKSPACE: cwd },
      fetchImpl: network, executionAdmissionKernel: kernel,
      deferSessionStartHooks: true, deferAgentStartupSideEffects: true,
      ...(mode === "absent" ? {} : { validatePreparedSampling: selected }),
    };
    const pending = bootstrapLocalRuntimeSession(options);
    await entered.promise;
    Object.assign(options, { validatePreparedSampling: swapped });
    release.resolve("/bin/bash");
    const boot = await pending;
    cleanups.push(() => boot.shutdown());
    expect(boot.session).toBeInstanceOf(Session);
    expect(boot.session.services.validatePreparedSampling).toBe(mode === "absent" ? undefined : selected);
    // Mutating the exposed service after construction must not replace the gate either.
    Object.assign(boot.session.services, { validatePreparedSampling: swapped });
    getAttachmentTrackingState(boot.session).memoryMode = "disabled";
    const events: unknown[] = [];
    for await (const event of boot.session.runTurn("Finish without tools.", { ctx: boot.ctx, systemPrompt: "" })) events.push(event);
    expect(swapped).not.toHaveBeenCalled();
    expect(selected).toHaveBeenCalledTimes(mode === "absent" ? 0 : 1);
    expect(chat).toHaveBeenCalledTimes(mode === "reject" ? 0 : 1);
    if (mode === "reject") {
      expect(journal()).toHaveLength(0);
      expect(events).toContainEqual(expect.objectContaining({
        type: "turn_complete", stopReason: "error",
        error: expect.objectContaining({ code: "prepared_sampling_validation_failed", name: "PreparedSamplingValidationError" }),
      }));
    } else {
      expect(journal().filter(row => row.event === "dispatched")).toHaveLength(1);
      expect(journal().filter(row => row.event === "reconciled")).toHaveLength(1);
    }
    expect(network).not.toHaveBeenCalled();
  }, 30_000);
});
