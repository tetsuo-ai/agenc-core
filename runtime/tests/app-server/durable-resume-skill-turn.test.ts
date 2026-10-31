/**
 * A turn the user started with a skill, interrupted by a daemon death, is
 * resumed by the REAL runner over the REAL bootstrap with the skill's
 * settings: the journal's record is checked against the skill registry the
 * restored session loads (a user skill under AGENC_HOME/skills, or an
 * installed plugin's skill, which the TUI names in the plugin's namespace) and
 * admitted again. A skill that changed meanwhile resumes on the session's
 * settings, with a warning saying so.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgenCDelegateBackgroundAgentRunner } from "../../src/app-server/background-agent-runner.js";
import { bootstrapLocalRuntimeSession } from "../../src/bin/bootstrap.js";
import { loadPlugins } from "../../src/plugins/loader.js";
import { loadPluginSkills } from "../../src/plugins/registration/load-plugin-commands.js";
import { skillInvocationSettingsFor } from "../../src/skills/skill-invocation-settings.js";
import { computeCheckpointPrefixHashV3 } from "../../src/session/durable-checkpoint-reader.js";
import {
  currentBuildId,
  resetBuildIdForTestingOnly,
} from "../../src/session/durable-turns.js";
import type { RolloutItem } from "../../src/session/rollout-item.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import { Session } from "../../src/session/session.js";
import type { SkillInvocationRecord } from "../../src/session/skill-invocation.js";
import type { TurnContext } from "../../src/session/turn-context.js";
import { VERSION } from "../../src/version.js";

const CONVERSATION_ID = "session-durable-resume-skill";
const TURN_ID = "skill-turn-interrupted";

const RECORD: SkillInvocationRecord = {
  name: "deep-review",
  source: "userSettings",
  requested: { allowedTools: ["Write"] },
  allowedTools: ["Write", "Skill(deep-review)"],
};

function interruptedSkillTurn(record: SkillInvocationRecord): RolloutItem[] {
  return [
    { type: "event_msg", payload: { eventId: `${TURN_ID}-started`, id: `${TURN_ID}-started`, seq: 1,
      msg: { type: "turn_started", payload: { turnId: TURN_ID, buildId: currentBuildId() } } } },
    { type: "turn_context", payload: { turnId: TURN_ID, cwd: "/tmp", approvalPolicy: "on_request",
      sandboxPolicy: "workspace_write", model: "base-model", skillInvocation: record } },
    { type: "event_msg", payload: { eventId: `${TURN_ID}-checkpoint`, id: `${TURN_ID}-checkpoint`, seq: 2,
      msg: { type: "turn_checkpoint", payload: {
        turnId: TURN_ID, iterationIndex: 1, boundary: "iteration", checkpointSeq: 1,
        persistedMessageCount: 0, prefixHash: computeCheckpointPrefixHashV3([], 0),
        checkpointVersion: 4, toolResultIntegrityVersion: 1, prefixHashVersion: 3,
        resumableState: { turnCount: 1, recoveryReentryCount: 0,
          maxOutputTokensRecoveryCount: 0, continuationNudgeCount: 0, stopHookBlockingCount: 0 },
      } } } },
  ] as unknown as RolloutItem[];
}

describe("durable resume of a skill turn through the daemon runner", () => {
  let home = "";
  let workspace = "";
  let rolloutPath = "";
  let previousBuildId: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "agenc-skill-resume-home-"));
    workspace = mkdtempSync(join(tmpdir(), "agenc-skill-resume-ws-"));
    mkdirSync(join(workspace, ".git"), { recursive: true });
    previousBuildId = process.env.AGENC_BUILD_ID;
    process.env.AGENC_BUILD_ID = "skill-resume-build";
    resetBuildIdForTestingOnly();
  });

  /** The journal a daemon death left: the interrupted turn of `record`. */
  function seedInterruptedTurn(record: SkillInvocationRecord): void {
    const seed = new RolloutStore({ cwd: workspace, sessionId: CONVERSATION_ID, agencVersion: VERSION,
      agencHome: home, sessionTempRoot: tmpdir(), autoStartScheduler: false });
    seed.open({ sessionId: CONVERSATION_ID, timestamp: new Date().toISOString(), cwd: workspace,
      originator: "agenc-cli", source: "interactive-root", agencVersion: VERSION,
      model: "base-model", modelProvider: "grok" });
    for (const item of interruptedSkillTurn(record)) seed.appendRollout(item);
    rolloutPath = seed.rolloutPath;
    seed.close();
  }

  /** An installed plugin with one skill, and plugins turned on. */
  function installPluginSkill(plugin: string, skill: string, allowedTools: string): void {
    const pluginRoot = join(home, "plugins", plugin);
    mkdirSync(join(pluginRoot, ".agenc-plugin"), { recursive: true });
    writeFileSync(join(pluginRoot, ".agenc-plugin", "plugin.json"),
      JSON.stringify({ name: plugin, version: "1.0.0" }));
    mkdirSync(join(pluginRoot, "skills", skill), { recursive: true });
    writeFileSync(join(pluginRoot, "skills", skill, "SKILL.md"), [
      "---",
      `description: The ${skill} skill of ${plugin}.`,
      `allowed-tools: ${allowedTools}`,
      "---",
      "Review the diff.",
      "",
    ].join("\n"));
    writeFileSync(join(home, "config.toml"), ["config_version = 2", "[plugins]", "enabled = true", ""].join("\n"));
  }

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousBuildId === undefined) delete process.env.AGENC_BUILD_ID;
    else process.env.AGENC_BUILD_ID = previousBuildId;
    resetBuildIdForTestingOnly();
    rmSync(home, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  function writeUserSkill(allowedTools: string): void {
    mkdirSync(join(home, "skills", "deep-review"), { recursive: true });
    writeFileSync(join(home, "skills", "deep-review", "SKILL.md"), [
      "---",
      "name: deep-review",
      "description: Review the diff carefully.",
      `allowed-tools: ${allowedTools}`,
      "---",
      "Review the diff.",
      "",
    ].join("\n"));
  }

  async function stubProvider(): Promise<void> {
    const providerMod = await import("../../src/llm/provider.js");
    vi.spyOn(providerMod, "createProvider").mockImplementation(() => ({
      name: "stub",
      getExecutionProfile: async () => ({ provider: "stub", model: "base-model",
        supportsMaxOutputTokens: true, maxOutputTokens: 8192, usageReporting: "authoritative" }),
      chat: async () => ({ content: "ok", toolCalls: [],
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } }),
    }) as never);
    vi.spyOn(Session.prototype, "startMcpManager").mockResolvedValue(undefined);
  }

  /** Capture the context of the resumed turn, then complete it. */
  function captureResumedTurn(): Promise<{ readonly ctx?: TurnContext; readonly subId?: string }> {
    const captured = Promise.withResolvers<{ readonly ctx?: TurnContext; readonly subId?: string }>();
    vi.spyOn(Session.prototype, "runTurn").mockImplementation(function (
      this: Session,
      _input: unknown,
      options?: { readonly resume?: unknown; readonly ctx?: TurnContext; readonly subId?: string },
    ) {
      if (options?.resume !== undefined) {
        captured.resolve({
          ...(options.ctx !== undefined ? { ctx: options.ctx } : {}),
          ...(options.subId !== undefined ? { subId: options.subId } : {}),
        });
      }
      return (async function* () {
        return { reason: "completed" as const };
      })() as never;
    });
    return captured.promise;
  }

  function recordWarnings(): Array<{ readonly cause: string; readonly message: string }> {
    const warnings: Array<{ readonly cause: string; readonly message: string }> = [];
    const emit = Session.prototype.emit;
    vi.spyOn(Session.prototype, "emit").mockImplementation(function (
      this: Session,
      event: Parameters<Session["emit"]>[0],
      appendOpts?: Parameters<Session["emit"]>[1],
    ) {
      if (event.msg.type === "warning") {
        const payload = event.msg.payload as { cause?: unknown; message?: unknown };
        warnings.push({ cause: String(payload.cause), message: String(payload.message) });
      }
      return emit.call(this, event, appendOpts);
    });
    return warnings;
  }

  function runner(): AgenCDelegateBackgroundAgentRunner {
    return new AgenCDelegateBackgroundAgentRunner({
      bootstrap: (options) => bootstrapLocalRuntimeSession(options),
      env: { ...process.env, AGENC_HOME: home, AGENC_WORKSPACE: workspace, HOME: home },
    });
  }

  function restoreParams(): never {
    return {
      agentId: CONVERSATION_ID,
      objective: "resume after daemon death",
      cwd: workspace,
      resumeRolloutPath: rolloutPath,
      explicitColdResume: true,
      envOverrides: { XAI_API_KEY: "test-key" },
    } as never;
  }

  async function within<T>(promise: Promise<T>, label: string): Promise<T> {
    return Promise.race([
      promise,
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 20_000)),
    ]);
  }

  it("resumes the interrupted turn with the skill's grants", async () => {
    seedInterruptedTurn(RECORD);
    writeUserSkill("Write");
    await stubProvider();
    const resumed = captureResumedTurn();
    const warnings = recordWarnings();
    const daemon = runner();
    try {
      await expect(daemon.restoreAgent(restoreParams())).resolves.toBe(true);
      const turn = await within(resumed, "the resumed turn");
      expect(turn.ctx?.subId).toBe(TURN_ID);
      expect(turn.ctx?.skillInvocation).toMatchObject({
        name: "deep-review",
        source: "userSettings",
        allowedTools: ["Write", "Skill(deep-review)"],
      });
      expect(warnings.filter((warning) => warning.cause.startsWith("durable_resume_skill")))
        .toEqual([]);
    } finally {
      await daemon.stopAgent(CONVERSATION_ID).catch(() => undefined);
    }
  }, 60_000);

  it("resumes on the session's settings, and says so, when the skill changed", async () => {
    seedInterruptedTurn(RECORD);
    writeUserSkill("Write, exec_command");
    await stubProvider();
    const resumed = captureResumedTurn();
    const warnings = recordWarnings();
    const daemon = runner();
    try {
      await expect(daemon.restoreAgent(restoreParams())).resolves.toBe(true);
      const turn = await within(resumed, "the resumed turn");
      expect(turn.ctx).toBeUndefined();
      expect(turn.subId).toBe(TURN_ID);
      expect(warnings).toContainEqual({
        cause: "durable_resume_skill_settings_dropped",
        message: expect.stringContaining("skill deep-review changed since the turn started"),
      });
    } finally {
      await daemon.stopAgent(CONVERSATION_ID).catch(() => undefined);
    }
  }, 60_000);

  it("resumes an installed plugin's skill turn, named in the plugin's namespace, with its grants", async () => {
    installPluginSkill("my-plugin", "review", "Write");
    // What the TUI sends for that skill, from the TUI's own plugin loader.
    const pluginStorageRoot = join(home, "plugins");
    const plugins = await loadPlugins({
      pluginStorageRoot, workspaceRoot: workspace, config: { plugins: { enabled: true } },
    });
    const commands = await loadPluginSkills({ cwd: workspace, pluginStorageRoot, plugins: plugins.enabled });
    expect(commands.map((command) => command.name)).toEqual(["my-plugin:review"]);
    const settings = skillInvocationSettingsFor(commands[0] as never)!;
    expect(settings).toEqual({ name: "my-plugin:review", source: "plugin", allowedTools: ["Write"] });
    seedInterruptedTurn({
      name: settings.name,
      source: "plugin",
      requested: { allowedTools: ["Write"] },
      allowedTools: ["Write", "Skill(my-plugin:review)"],
    });
    await stubProvider();
    const resumed = captureResumedTurn();
    const warnings = recordWarnings();
    const daemon = runner();
    try {
      await expect(daemon.restoreAgent(restoreParams())).resolves.toBe(true);
      const turn = await within(resumed, "the resumed turn");
      expect(turn.ctx?.subId).toBe(TURN_ID);
      expect(turn.ctx?.skillInvocation).toMatchObject({
        name: "my-plugin:review",
        source: "plugin",
        allowedTools: ["Write", "Skill(my-plugin:review)"],
      });
      expect(warnings.filter((warning) => warning.cause.startsWith("durable_resume_skill")))
        .toEqual([]);
    } finally {
      await daemon.stopAgent(CONVERSATION_ID).catch(() => undefined);
    }
  }, 60_000);
});
