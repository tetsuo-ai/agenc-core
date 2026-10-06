import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readdirSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowSessionSeams } from "../../src/app-server/workflow/session-adapters.js";
import { EventLog } from "../../src/session/event-log.js";
import { PermissionModeRegistry } from "../../src/permissions/permission-mode.js";
import { openStateDatabases } from "../../src/state/sqlite-driver.js";
import { StateRunDurabilityRepository } from "../../src/state/run-durability.js";
import { requireProviderRuntimeCredential, resolveProviderRuntimeAuthority } from "../../src/llm/provider-options.js";
const capture = vi.hoisted(() => ({ parents: [] as any[], reviews: [] as any[] }));
vi.mock("../../src/bin/delegate-tool.js", () => ({ ensureAgentControl: () => ({ control: {}, registry: {} }) }));
vi.mock("../../src/agents/delegate.js", () => ({ delegate: async (input: any) => {
  capture.parents.push(input.parent);
  return { kind: "sync_completed", result: { outcome: "completed", finalMessage: "done", threadId: "child" } };
} }));
vi.mock("../../src/session/agenc-delegate.js", async original => ({
  ...await original<typeof import("../../src/session/agenc-delegate.js")>(),
  buildGuardianReviewSessionConfig: () => ({}),
  runAgenCReviewOneShot: async (_session: any, input: any) => { capture.reviews.push(input.parentContext); return { rawText: "approved", verdict: "pass", error: null }; },
}));
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); capture.parents = []; capture.reviews = []; });
it("delivers a current credential to bootstrap, every child and review without journaling it; restart loses it clearly", async () => {
  const home = mkdtempSync(join(tmpdir(), "workflow-credentials-")); dirs.push(home);
  const driver = openStateDatabases({ cwd: home, agencHome: home });
  const repo = new StateRunDurabilityRepository(driver);
  const secret = "workflow-ephemeral-only-sentinel-credential";
  const events: unknown[] = [];
  const bootstrap = vi.fn(async (options: any) => {
    const authority = await resolveProviderRuntimeAuthority("deepseek", { model: "deepseek-flash" }, options.env);
    requireProviderRuntimeCredential("deepseek", authority);
    const eventLog = new EventLog();
    eventLog.subscribe(event => { events.push(event); appendFileSync(join(home, "rollout.jsonl"), JSON.stringify(event) + "\n"); });
    const session = { conversationId: options.conversationId, abortController: new AbortController(), services: {},
      providerService: { environment: () => options.env },
      permissionModeRegistry: new PermissionModeRegistry({ mode: "default", additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {}, alwaysAskRules: {}, isBypassPermissionsModeAvailable: true }),
      emit: (event: any) => eventLog.emit(event) };
    return { session, ctx: { environment: options.env }, config: {}, rolloutStore: { runEpoch: 1 }, shutdown: async () => {} } as never;
  });
  const options = { agencHome: home, env: {}, argv: ["node", "agenc"], kernel: {} as never, durability: () => repo,
    resolveRunRepoPath: () => home, resolveRunPolicy: () => ({ permissionMode: "default" as const, provider: "deepseek", model: "deepseek-flash" }), fallbackCwd: home, warn: () => {}, bootstrap };
  const seams = createWorkflowSessionSeams(options);
  try {
    const journal = await seams.journal.open("wf-creds", { repoPath: home, envOverrides: { DEEPSEEK_API_KEY: secret } });
    repo.ensureInitialEpoch({ runId: "wf-creds", openedAt: "2026-09-27T00:00:00.000Z" });
    journal.appendIntent({ stepId: "workflow.intake", toolName: "workflow.intake", recoveryCategory: "idempotent", idempotencyKey: "test-intake", intentDigest: "sha256:test-intake", intentAt: "2026-09-27T00:00:00.000Z" });
    journal.appendResult({ stepId: "workflow.intake", outcome: "committed", evidence: { goal: "work" }, completedAt: "2026-09-27T00:00:01.000Z" });
    for (const kind of ["plan", "implement", "verify_agent", "review"] as const) {
      await seams.spawner.spawn({ kind, spec: { runId: "wf-creds", model: "deepseek-flash" }, childRunId: `wf-creds:${kind}#1`, prompt: "work", signal: new AbortController().signal } as never);
    }
    await seams.reviewer.invoke({ runId: "wf-creds", reviewerModel: "deepseek-flash", systemPrompt: "review", userMessage: "diff", timeoutMs: 1000 } as never);
    expect(capture.parents).toHaveLength(4);
    for (const parent of capture.parents) expect(parent.providerService.environment().DEEPSEEK_API_KEY).toBe(secret);
    expect(capture.reviews[0].environment.DEEPSEEK_API_KEY).toBe(secret);
    await seams.journal.open("wf-creds"); expect(bootstrap).toHaveBeenCalledOnce();
    await journal.close();
    await expect(createWorkflowSessionSeams(options).journal.open("wf-creds")).rejects.toThrow("deepseek provider requires credentials. Set DEEPSEEK_API_KEY.");
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(readFileSync(join(home, "rollout.jsonl"), "utf8")).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain(secret);
    const scan = (dir: string): void => { for (const entry of readdirSync(dir, { withFileTypes: true })) { const path = join(dir, entry.name); if (entry.isDirectory()) scan(path); else if (entry.isFile()) expect(readFileSync(path).includes(Buffer.from(secret)), path).toBe(false); } };
    scan(home);
  } finally { await seams.close(); driver.close(); }
});
