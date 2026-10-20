import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getProjectRoot, setProjectRoot } from "../../../src/bootstrap/state.js";
import { ConfigStore } from "../../../src/config/store.js";
import type { LLMMessage } from "../../../src/llm/types.js";
import { buildProjectMemoryDirectory } from "../../../src/memory/paths.js";
import {
  executeExtractMemories,
  initExtractMemories,
  type ExtractMemoriesChildRequest,
} from "../../../src/services/extractMemories/extractMemories.js";
import { resolveAgentRuntimeOptions } from "../../../src/session/runtime-options.js";
import type { Session } from "../../../src/session/session.js";
import type { TurnContext } from "../../../src/session/turn-context.js";
import { runWithCanonicalSettingsAuthority } from "../../../src/utils/settings/canonicalAuthority.js";

vi.mock("bun:bundle", () => ({ feature: () => false }));

/**
 * Background memory extraction checks, before it spends a child run, that the
 * runtime sandbox will let the child's Write calls into the memory directory.
 * It asked the process-wide question, while the sandbox itself (and the
 * session's memory prompt) use the session's own memory directories. A daemon
 * runs in its own working directory, so the process-wide project directory is
 * the daemon's project's: under workspace_write every daemon session's
 * extraction stopped with "memory directory is not writable under the current
 * sandbox", while the same session in a direct run extracted.
 */
let root: string;
let workspace: string;
let home: string;
let previousAgencHome: string | undefined;
let previousProjectRoot: string;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "agenc-extract-daemon-")));
  workspace = join(root, "project");
  home = join(root, "home");
  await mkdir(workspace);
  await mkdir(home);
  previousAgencHome = process.env.AGENC_HOME;
  process.env.AGENC_HOME = home;
  previousProjectRoot = getProjectRoot();
  // The daemon process starts in its own directory, not in the session's.
  const daemonDir = join(root, "daemon-home");
  await mkdir(daemonDir);
  setProjectRoot(daemonDir);
});

afterEach(async () => {
  setProjectRoot(previousProjectRoot);
  if (previousAgencHome === undefined) delete process.env.AGENC_HOME;
  else process.env.AGENC_HOME = previousAgencHome;
  await rm(root, { recursive: true, force: true });
});

interface Warning { readonly cause: string; readonly message: string }

function daemonSession(
  warnings: Warning[],
  runtimeOptions: Record<string, unknown> = {},
  configStore: ConfigStore | undefined = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: workspace }),
): Session {
  let subId = 0;
  return {
    conversationId: `daemon-${Math.random().toString(36).slice(2)}`,
    services: {
      ...(configStore !== undefined ? { configStore } : {}),
      runtimeOptions: {
        ...resolveAgentRuntimeOptions({ AGENC_HOME: home }, { sessionTempRoot: join(root, "session-tmp") }),
        ...runtimeOptions,
      },
    },
    nextInternalSubId: () => String(subId++),
    emit: (event: { msg: { type: string; payload: unknown } }) => {
      if (event.msg.type === "warning") warnings.push(event.msg.payload as Warning);
    },
  } as unknown as Session;
}

/** A main-session turn under the default workspace_write sandbox (reads anywhere, writes in the workspace). */
function workspaceWriteTurn(denyWrite: readonly string[] = []): TurnContext {
  return {
    cwd: workspace,
    depth: 0,
    sessionSource: "cli_main",
    sandboxPolicy: { value: "workspace_write" },
    fileSystemSandboxPolicy: { allowRead: [], denyRead: [], allowWrite: [workspace], denyWrite: [...denyWrite] },
    networkSandboxPolicy: { allowlist: [], denylist: [], allowManagedDomainsOnly: false },
  } as unknown as TurnContext;
}

const MESSAGES: readonly LLMMessage[] = [
  { role: "user", content: "Our staging server is heron-stage-7 and deploys only happen on Thursdays." },
  { role: "assistant", content: "Noted." },
];

/** Extraction at the end of a turn, under the session's settings as in a daemon turn. */
async function extractAtTurnEnd(session: Session, ctx: TurnContext): Promise<ReturnType<typeof vi.fn>> {
  const runChild = vi.fn(async (_request: ExtractMemoriesChildRequest) => ({ outcome: "completed" as const }));
  initExtractMemories({ env: {}, minEligibleTurns: 1, runChild, scanMemoryFiles: async () => [] });
  const configStore = (session.services as { configStore?: ConfigStore }).configStore;
  const run = () => executeExtractMemories({ messages: MESSAGES, completedToolResults: [], ctx, session });
  if (configStore !== undefined) await runWithCanonicalSettingsAuthority(configStore, run);
  else await run();
  return runChild;
}

const NOT_WRITABLE = "memory directory is not writable under the current sandbox";

function skippedAsNotWritable(warnings: readonly Warning[]): boolean {
  return warnings.some((warning) =>
    warning.cause === "memory_extraction_skipped" && warning.message.startsWith(NOT_WRITABLE));
}

describe("background memory extraction in a daemon session", () => {
  it("runs the child for the session's own project memory under workspace_write", async () => {
    const warnings: Warning[] = [];
    const runChild = await extractAtTurnEnd(daemonSession(warnings), workspaceWriteTurn());
    expect(skippedAsNotWritable(warnings), JSON.stringify(warnings)).toBe(false);
    expect(runChild).toHaveBeenCalledOnce();
    const request = runChild.mock.calls[0]![0] as ExtractMemoriesChildRequest;
    expect(request.memoryDir).toBe(buildProjectMemoryDirectory(home, workspace));
  });

  it("still stops before the child when an operator denies the memory directory", async () => {
    const warnings: Warning[] = [];
    const memoryDir = buildProjectMemoryDirectory(home, workspace);
    const runChild = await extractAtTurnEnd(daemonSession(warnings), workspaceWriteTurn([memoryDir]));
    expect(runChild).not.toHaveBeenCalled();
    expect(skippedAsNotWritable(warnings), JSON.stringify(warnings)).toBe(true);
  });

  it("stays off when a cowork override moved the session's memory", async () => {
    const warnings: Warning[] = [];
    const session = daemonSession(warnings, { coworkMemoryPathOverride: join(root, "cowork-memory") });
    const runChild = await extractAtTurnEnd(session, workspaceWriteTurn());
    expect(runChild).not.toHaveBeenCalled();
    expect(skippedAsNotWritable(warnings), JSON.stringify(warnings)).toBe(true);
  });

  it("stays off when the session's auto memory is off", async () => {
    for (const session of [
      daemonSession([], { simpleMode: true }),
      daemonSession([], {}, new ConfigStore({ home, env: { AGENC_HOME: home }, cwd: workspace, cliOverrides: { autoMemoryEnabled: false } })),
    ]) {
      const configStore = (session.services as { configStore?: ConfigStore }).configStore;
      await configStore?.reload();
      const warnings: Warning[] = [];
      Object.assign(session, { emit: (event: { msg: { type: string; payload: unknown } }) => {
        if (event.msg.type === "warning") warnings.push(event.msg.payload as Warning);
      } });
      const runChild = await extractAtTurnEnd(session, workspaceWriteTurn());
      expect(runChild).not.toHaveBeenCalled();
      expect(warnings.map((warning) => warning.message).join("\n")).toMatch(/memory directory unavailable/u);
    }
  });
});
