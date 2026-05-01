/**
 * Starts daemon-owned background agents through the existing delegate runtime.
 *
 * F-06a keeps the daemon surface narrow: `agent.create` requests become
 * `delegate(..., runInBackground: true)` launches, and the daemon holds the
 * bootstrap/session handles so the child loop remains alive after the JSON-RPC
 * response is returned.
 */

import {
  bootstrapLocalRuntimeSession,
  type BootstrapLocalRuntimeSessionOptions,
  type LocalRuntimeBootstrap,
} from "../bin/bootstrap.js";
import { ensureAgentControl } from "../bin/delegate-tool.js";
import {
  delegate,
  type DelegateOpts,
  type DelegateOutcome,
} from "../agents/delegate.js";
import type { AgentControl } from "../agents/control.js";
import type { AgentPath } from "../agents/registry.js";
import type { AgentThread } from "../agents/thread.js";
import { setRulesForSource } from "../permissions/rules.js";
import type { PermissionModeRegistry } from "../permissions/mode.js";
import type { ToolPermissionContext } from "../permissions/types.js";
import type { JsonObject } from "./protocol/index.js";

export interface AgenCBackgroundAgentStartParams {
  readonly objective: string;
  readonly cwd?: string;
  readonly model?: string;
  readonly provider?: string;
  readonly profile?: string;
  readonly metadata?: JsonObject;
  readonly unattendedAllow: readonly string[];
  readonly unattendedDeny: readonly string[];
}

export interface AgenCBackgroundAgentStartResult {
  readonly agentId: string;
  readonly agentPath?: string;
  readonly startedAt: string;
  readonly status: "running";
}

export interface AgenCBackgroundAgentRunner {
  startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult>;
  stopAgent?(agentId: string, reason?: string): Promise<void>;
}

export type AgenCDelegateFunction = (opts: DelegateOpts) => Promise<DelegateOutcome>;
export type AgenCBootstrapFunction = (
  options: BootstrapLocalRuntimeSessionOptions,
) => Promise<LocalRuntimeBootstrap>;
export type AgenCEnsureAgentControlFunction = typeof ensureAgentControl;

interface ActiveBackgroundAgent {
  readonly bootstrap: LocalRuntimeBootstrap;
  readonly control: AgentControl;
  readonly thread: AgentThread;
}

export interface AgenCDelegateBackgroundAgentRunnerOptions {
  readonly bootstrap?: AgenCBootstrapFunction;
  readonly delegateFn?: AgenCDelegateFunction;
  readonly ensureAgentControl?: AgenCEnsureAgentControlFunction;
  readonly env?: NodeJS.ProcessEnv;
  readonly argv?: readonly string[];
  readonly now?: () => string;
}

export class AgenCDelegateBackgroundAgentRunner
  implements AgenCBackgroundAgentRunner
{
  readonly #bootstrap: AgenCBootstrapFunction;
  readonly #delegate: AgenCDelegateFunction;
  readonly #ensureAgentControl: AgenCEnsureAgentControlFunction;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #argv: readonly string[] | undefined;
  readonly #now: () => string;
  readonly #active = new Map<string, ActiveBackgroundAgent>();

  constructor(options: AgenCDelegateBackgroundAgentRunnerOptions = {}) {
    this.#bootstrap = options.bootstrap ?? bootstrapLocalRuntimeSession;
    this.#delegate = options.delegateFn ?? delegate;
    this.#ensureAgentControl =
      options.ensureAgentControl ?? ensureAgentControl;
    this.#env = options.env;
    this.#argv = options.argv;
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  async startAgent(
    params: AgenCBackgroundAgentStartParams,
  ): Promise<AgenCBackgroundAgentStartResult> {
    const bootstrap = await this.#bootstrap({
      ...(this.#env !== undefined ? { env: this.#env } : {}),
      argv: buildBootstrapArgv(params, this.#argv),
      ...(params.cwd !== undefined ? { cwd: params.cwd } : {}),
    });

    try {
      const { control, registry } = this.#ensureAgentControl(bootstrap.session);
      await applyUnattendedPermissionPolicy(
        bootstrap.session.permissionModeRegistry,
        params.unattendedAllow,
        params.unattendedDeny,
      );
      const outcome = await this.#delegate({
        parent: bootstrap.session,
        parentPath: "/root" as AgentPath,
        control,
        registry,
        taskPrompt: params.objective,
        runInBackground: true,
        isolation: "cwd",
        ...(params.model !== undefined ? { model: params.model } : {}),
      });

      if (outcome.kind !== "async_launched") {
        throw new Error(
          outcome.kind === "rejected"
            ? outcome.reason
            : "background delegate returned synchronously",
        );
      }

      this.#active.set(outcome.thread.threadId, {
        bootstrap,
        control,
        thread: outcome.thread,
      });
      this.#cleanupWhenComplete(outcome.thread.threadId, outcome.thread);
      return {
        agentId: outcome.thread.threadId,
        agentPath: outcome.thread.agentPath,
        startedAt: this.#now(),
        status: "running",
      };
    } catch (error) {
      await bootstrap.shutdown().catch(() => {});
      throw error;
    }
  }

  async stopAgent(agentId: string, reason = "daemon_agent_stop"): Promise<void> {
    const active = this.#active.get(agentId);
    if (active === undefined) return;
    this.#active.delete(agentId);
    await active.control.shutdown(agentId, reason).catch(() => {});
    await active.bootstrap.shutdown().catch(() => {});
  }

  #cleanupWhenComplete(agentId: string, thread: AgentThread): void {
    void thread
      .join()
      .catch(() => {})
      .finally(async () => {
        const active = this.#active.get(agentId);
        if (active === undefined || active.thread !== thread) return;
        this.#active.delete(agentId);
        await active.bootstrap.shutdown().catch(() => {});
      });
  }
}

function buildBootstrapArgv(
  params: AgenCBackgroundAgentStartParams,
  baseArgv: readonly string[] | undefined,
): readonly string[] {
  const argv = [...(baseArgv ?? process.argv)];
  appendFlag(argv, "--provider", params.provider);
  appendFlag(argv, "--model", params.model);
  appendFlag(argv, "--profile", params.profile);
  if (!argv.includes("--autonomous") && !argv.includes("--proactive")) {
    argv.push("--autonomous");
  }
  return argv;
}

function appendFlag(argv: string[], flag: string, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return;
  argv.push(flag, trimmed);
}

async function applyUnattendedPermissionPolicy(
  registry: PermissionModeRegistry,
  allow: readonly string[],
  deny: readonly string[],
): Promise<void> {
  const allowed = mergeRuleStrings(registry.current(), "allow", allow);
  const denied = mergeRuleStrings(registry.current(), "deny", deny);
  let next = setRulesForSource(registry.current(), "session", "allow", allowed);
  next = setRulesForSource(next, "session", "deny", denied);
  await registry.update(next);
}

function mergeRuleStrings(
  context: ToolPermissionContext,
  behavior: "allow" | "deny",
  values: readonly string[],
): readonly string[] {
  const existing =
    behavior === "allow"
      ? context.alwaysAllowRules.session ?? []
      : context.alwaysDenyRules.session ?? [];
  const seen = new Set(existing);
  const merged = [...existing];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    merged.push(trimmed);
  }
  return merged;
}
