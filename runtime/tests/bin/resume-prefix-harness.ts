/**
 * Resume harness: real turns, a scripted OpenAI Responses backend, request bodies.
 *
 * Turns run through the daemon turn driver over the real bootstrap. The
 * backend answers like a small model would (a FileRead of the file the prompt
 * names, then a short answer, and a checked line for a completion review) and
 * records every request body. A test shuts the session down, or lets its
 * process die by restoring a copy of the home taken while a request was in
 * flight, then bootstraps it again with resume and compares the requests.
 */
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, vi } from "vitest";

import { __installDaemonTurnDriverHooksForTest } from "../../src/app-server/background-agent-runner.js";
import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { SandboxExecutionBroker } from "../../src/sandbox/execution-broker.js";
import { resolveAgentRuntimeOptions } from "../../src/session/runtime-options.js";
import { Session } from "../../src/session/session.js";

export type Item = Record<string, unknown>;
export type Body = Record<string, unknown> & { readonly input: Item[] };
export type ResumeMode = "light" | "standard";
type Boot = Awaited<ReturnType<typeof bootstrapLocalRuntimeSession>>;

export const CONVERSATION_ID = "conv-resumed-1";

function sse(events: readonly Item[]): Response {
  const text = events.map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`).join("");
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

export function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args],
    { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

export function itemText(item: Item | undefined): string {
  const content = item?.content;
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.map((part) => String((part as Item).text ?? "")).join("") : "";
}

function scriptedOutput(body: Body, n: number): Item[] {
  const last = body.input.at(-1);
  if (last?.type === "function_call_output") {
    return [{ type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: `Read it (${n}).`, annotations: [] }] }];
  }
  const text = itemText(last);
  if (text.includes("<completion_gate")) {
    return [{ type: "message", id: `msg_${n}`, role: "assistant", status: "completed",
      content: [{ type: "output_text", text: "- [x] Read the file (FileRead).", annotations: [] }] }];
  }
  const file = /\b([a-z]+\.txt)\b/u.exec(text)?.[1] ?? "a.txt";
  return [{ type: "function_call", id: `fc_${n}`, call_id: `call_${n}`, name: "FileRead",
    arguments: JSON.stringify({ file_path: file }), status: "completed" }];
}

/**
 * The sandboxed `git rev-parse` of the prompt's branch line, which cannot
 * spawn under the hermetic test runner, runs unsandboxed here, or fails when
 * `fail()` says so, as it does on a loaded machine.
 */
export function controlGitBranchSpawn(fail: () => boolean = () => false): void {
  const prepareSpawn = SandboxExecutionBroker.prototype.prepareSpawn;
  vi.spyOn(SandboxExecutionBroker.prototype, "prepareSpawn").mockImplementation(function (
    this: SandboxExecutionBroker, ...args: Parameters<typeof prepareSpawn>
  ) {
    const command = args[1];
    if (command.program !== "git" || !command.args.includes("rev-parse")) return prepareSpawn.apply(this, args);
    if (fail()) throw new Error("spawnSync git ETIMEDOUT");
    return { runSync: (run: (spawn: typeof command) => unknown) => run(command) } as never;
  });
}

export class ResumeHarness {
  readonly bodies: Body[] = [];
  /** Index into `bodies` where the requests of each bootstrap begin. */
  readonly starts: number[] = [];
  /** Called with each request before it is answered. */
  onRequest: ((body: Body, index: number) => void) | undefined;
  private boot: Boot | undefined;
  /** Index into `bodies` of the current conversation's first request. */
  private conversationStart = 0;

  private constructor(
    readonly mode: ResumeMode,
    readonly home: string,
    readonly workspace: string,
  ) {}

  static async create(mode: ResumeMode): Promise<ResumeHarness> {
    const home = await mkdtemp(join(tmpdir(), "rp-home-"));
    const workspace = await mkdtemp(join(tmpdir(), "rp-ws-"));
    git(workspace, "init", "-q", "-b", "main");
    for (const name of ["a", "b", "c", "d"]) await writeFile(join(workspace, `${name}.txt`), `${name}\n`);
    git(workspace, "add", ".");
    git(workspace, "commit", "-qm", "init");
    const harness = new ResumeHarness(mode, home, workspace);
    await harness.installBackend();
    return harness;
  }

  private async installBackend(): Promise<void> {
    const { OpenAIProvider } = await import("../../src/llm/providers/openai/adapter.js");
    const providerModule = await import("../../src/llm/provider.js");
    vi.spyOn(providerModule, "createProvider").mockImplementation(() => new OpenAIProvider({
      apiKey: "test", model: "gpt-6.1-terra", useResponsesApi: true,
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as Body;
        this.bodies.push(body);
        this.onRequest?.(body, this.bodies.length - 1);
        // Item ids count within the conversation, as a backend's would be unique in it.
        const n = this.bodies.length - this.conversationStart;
        const output = scriptedOutput(body, n);
        const response = { id: `resp_${n}`, object: "response", model: "gpt-6.1-terra", status: "completed",
          output, usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 } };
        return sse([
          ...output.map((item, index) => ({ type: "response.output_item.done", output_index: index, item })),
          { type: "response.completed", response },
        ]);
      },
    }));
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  }

  async start(resume: boolean, conversationId = CONVERSATION_ID): Promise<void> {
    const env = { ...process.env, HOME: this.home, AGENC_HOME: this.home, AGENC_WORKSPACE: this.workspace,
      AGENC_PROVIDER: "openai", AGENC_MODEL: "gpt-6.1-terra" };
    this.starts.push(this.bodies.length);
    if (!resume) this.conversationStart = this.bodies.length;
    this.boot = await bootstrapLocalRuntimeSession({
      apiKey: "test", conversationId, costSummaryOnExit: false, resumeConversation: resume,
      argv: ["node", "agenc", "--permission-mode", "acceptEdits"],
      runtimeOptions: resolveAgentRuntimeOptions(env, {
        nonInteractive: true, ...(this.mode === "light" ? { lightMode: true } : {}),
      }),
      env,
    });
    __installDaemonTurnDriverHooksForTest(this.boot.session, this.boot.configStore);
  }

  async turn(prompt: string): Promise<void> {
    await this.boot!.session.submit(prompt);
  }

  async stop(): Promise<void> {
    const boot = this.boot;
    this.boot = undefined;
    await boot?.shutdown();
  }

  /**
   * Copy the home as it is on disk now: what a process killed at this moment
   * leaves behind. Synchronous, so no other write interleaves.
   */
  snapshotHome(): string {
    const copy = `${this.home}.killed`;
    rmSync(copy, { recursive: true, force: true });
    cpSync(this.home, copy, { recursive: true });
    return copy;
  }

  /**
   * Put a snapshot back in place of the home, after the session stopped. The
   * dead process's journal locks name this live test process, so they go:
   * a real restart finds them held by a dead pid and takes them over.
   */
  restoreHome(copy: string): void {
    rmSync(this.home, { recursive: true, force: true });
    cpSync(copy, this.home, { recursive: true });
    rmSync(copy, { recursive: true, force: true });
    const files = readdirSync(this.home, { recursive: true, encoding: "utf8" });
    for (const file of files) if (file.endsWith(".lock")) rmSync(join(this.home, file), { force: true });
  }

  /** The request bodies with this harness's paths and conversation ids replaced. */
  normalized(bodies: readonly Body[], conversationId: string): Body[] {
    return JSON.parse(JSON.stringify(bodies).split(conversationId).join("<conversation>")) as Body[];
  }

  async dispose(): Promise<void> {
    await this.stop().catch(() => undefined);
    await rm(this.home, { recursive: true, force: true });
    await rm(`${this.home}.killed`, { recursive: true, force: true });
    await rm(this.workspace, { recursive: true, force: true });
  }
}

/** Items of `next` that repeat `previous` from the start, before the first change. */
export function samePrefixLength(previous: readonly Item[], next: readonly Item[]): number {
  let index = 0;
  while (index < previous.length && index < next.length &&
    JSON.stringify(previous[index]) === JSON.stringify(next[index])) index += 1;
  return index;
}

/**
 * The first request after a resume repeats the request sent before it: the
 * same instructions, tools and cache key, and every earlier input item.
 */
export function expectPrefixKept(previous: Body, resumed: Body): void {
  expect(resumed.instructions).toBe(previous.instructions);
  expect(resumed.tools).toEqual(previous.tools);
  expect(resumed.prompt_cache_key).toBe(previous.prompt_cache_key);
  const kept = samePrefixLength(previous.input, resumed.input);
  expect(resumed.input.slice(0, previous.input.length)).toEqual(previous.input);
  expect(kept).toBe(previous.input.length);
}
