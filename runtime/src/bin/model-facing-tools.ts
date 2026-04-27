import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";
import { delegate } from "../agents/delegate.js";
import type { AgentPath, ThreadId } from "../agents/registry.js";
import type { AgentStatus } from "../agents/status.js";
import type { Session } from "../session/session.js";
import type { Tool, ToolResult } from "../tools/types.js";
import { safeStringify } from "../tools/types.js";
import type { UnifiedExecProcessManagerLike } from "../unified-exec/index.js";
import {
  formatUnifiedExecToolContent,
  unifiedExecCodeModeResult,
} from "../tools/system/exec-result-format.js";
import {
  CodeIntelManager,
  toRelativeWorkspacePath,
} from "../tools/system/code-intel.js";
import { ensureAgentControl } from "./delegate-tool.js";

export interface ModelFacingToolOptions {
  readonly workspaceRoot: string;
  readonly agencHome?: string;
  readonly getSession: () => Session | null;
  readonly unifiedExecManager?: UnifiedExecProcessManagerLike;
  readonly emitWarning?: (warning: {
    readonly cause: string;
    readonly message: string;
  }) => void;
  readonly env?: NodeJS.ProcessEnv;
}

interface StoredTask {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly activeForm?: string;
  readonly status: "pending" | "in_progress" | "completed" | "cancelled";
  readonly blocks: readonly string[];
  readonly blockedBy: readonly string[];
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface StoredCron {
  readonly id: string;
  readonly schedule: string;
  readonly prompt: string;
  readonly timezone?: string;
  readonly durable: boolean;
  readonly createdAt: string;
}

interface ToolState {
  readonly tasks: readonly StoredTask[];
  readonly crons: readonly StoredCron[];
}

interface SpawnedAgentRecord {
  readonly threadId: string;
  readonly agentPath: string;
  readonly nickname: string;
  readonly join: () => Promise<unknown>;
  readonly status: () => AgentStatus;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FETCH_CHARS = 120_000;
const MAX_SEARCH_RESULTS = 8;

function json(content: unknown, isError?: boolean): ToolResult {
  return { content: safeStringify(content), ...(isError ? { isError: true } : {}) };
}

function toolMetadata(
  family: string,
  opts: {
    readonly mutating?: boolean;
    readonly deferred?: boolean;
    readonly keywords?: readonly string[];
  } = {},
): Tool["metadata"] {
  return {
    family,
    source: "builtin",
    hiddenByDefault: false,
    mutating: opts.mutating ?? false,
    deferred: opts.deferred ?? false,
    keywords: opts.keywords ?? [family],
    preferredProfiles: ["coding", "operator", "general"],
  };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function boolValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function stateRoot(opts: ModelFacingToolOptions): string {
  return opts.agencHome ?? join(homedir(), ".agenc");
}

function stateFile(opts: ModelFacingToolOptions): string {
  return join(stateRoot(opts), "runtime-tools", "state.json");
}

async function readState(opts: ModelFacingToolOptions): Promise<ToolState> {
  try {
    const raw = await readFile(stateFile(opts), "utf8");
    const parsed = JSON.parse(raw) as Partial<ToolState>;
    return {
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [],
      crons: Array.isArray(parsed.crons) ? parsed.crons : [],
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { tasks: [], crons: [] };
    }
    throw error;
  }
}

async function writeState(opts: ModelFacingToolOptions, state: ToolState): Promise<void> {
  const file = stateFile(opts);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

function resolveWorkspacePath(opts: ModelFacingToolOptions, input: string): string {
  const resolved = isAbsolute(input) ? resolve(input) : resolve(opts.workspaceRoot, input);
  const root = resolve(opts.workspaceRoot);
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`path is outside the workspace: ${input}`);
  }
  return resolved;
}

function htmlToText(input: string): string {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchWithTimeout(url: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "user-agent": "agenc-runtime/0.2",
        accept: "text/html,text/plain,application/json,*/*",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(raw: string): string {
  const input = raw.startsWith("http://")
    ? `https://${raw.slice("http://".length)}`
    : raw;
  const url = new URL(input);
  if (url.protocol !== "https:") {
    throw new Error("URL must use https");
  }
  return url.toString();
}

function parseTarget(args: Record<string, unknown>): string | undefined {
  return (
    stringValue(args.target) ??
    stringValue(args.agent_id) ??
    stringValue(args.agentId) ??
    stringValue(args.task_id) ??
    stringValue(args.taskId) ??
    stringValue(args.id)
  );
}

function resolveAgentId(
  session: Session,
  target: string,
): ThreadId {
  const { control } = ensureAgentControl(session);
  try {
    return control.resolveAgentReference({
      currentAgentPath: "/root",
      reference: target,
    });
  } catch {
    return target;
  }
}

function getSessionOrError(opts: ModelFacingToolOptions): Session | ToolResult {
  const session = opts.getSession();
  if (session === null) {
    return json({ error: "tool invoked before session was initialized" }, true);
  }
  return session;
}

function promptFromAgentArgs(args: Record<string, unknown>): string | undefined {
  const direct =
    stringValue(args.message) ??
    stringValue(args.prompt) ??
    stringValue(args.task) ??
    stringValue(args.taskPrompt) ??
    stringValue(args.description);
  if (direct) return direct;
  if (!Array.isArray(args.items)) return undefined;
  const parts = args.items
    .map((item) => {
      if (typeof item === "string") return item;
      if (typeof item !== "object" || item === null) return "";
      const record = item as Record<string, unknown>;
      return stringValue(record.text) ?? stringValue(record.path) ?? "";
    })
    .filter((part) => part.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function createAgentTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const spawned = new Map<string, SpawnedAgentRecord>();

  const spawn = async (
    args: Record<string, unknown>,
    aliasName: string,
  ): Promise<ToolResult> => {
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const session = sessionOrError;
    const prompt = promptFromAgentArgs(args);
    if (!prompt) {
      return json({ error: "message or task prompt is required" }, true);
    }
    const { control, registry } = ensureAgentControl(session);
    const role =
      stringValue(args.agent_type) ??
      stringValue(args.agentType) ??
      stringValue(args.subagent_type) ??
      stringValue(args.role);
    const forkContext =
      boolValue(args.fork_context) ??
      boolValue(args.forkContext) ??
      boolValue(args.fork_turns);
    const runInBackground =
      boolValue(args.run_in_background) ??
      boolValue(args.runInBackground) ??
      true;

    const outcome = await delegate({
      parent: session,
      parentPath: "/root" as AgentPath,
      control,
      registry,
      taskPrompt: prompt,
      ...(role !== undefined ? { role } : {}),
      forkMode: forkContext === true ? { kind: "full_history" } : { kind: "new" },
      runInBackground,
    });

    if (outcome.kind === "rejected") {
      return json({ error: outcome.reason }, true);
    }
    const thread = outcome.thread;
    spawned.set(thread.threadId, {
      threadId: thread.threadId,
      agentPath: thread.agentPath,
      nickname: thread.nickname,
      join: () => thread.join(),
      status: () => thread.currentStatus,
    });
    spawned.set(thread.agentPath, spawned.get(thread.threadId)!);
    spawned.set(thread.nickname, spawned.get(thread.threadId)!);

    if (outcome.kind === "sync_completed") {
      return json({
        tool: aliasName,
        status: "completed",
        agent_id: thread.threadId,
        agent_path: thread.agentPath,
        nickname: thread.nickname,
        result: outcome.result,
      });
    }
    return json({
      tool: aliasName,
      status: "running",
      agent_id: thread.threadId,
      agent_path: thread.agentPath,
      nickname: thread.nickname,
    });
  };

  const waitForAgent = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const targets = stringArray(args.targets);
    const target =
      parseTarget(args) ??
      (targets.length === 1 ? targets[0] : undefined);
    if (!target && targets.length === 0) {
      return json({ error: "target or targets is required" }, true);
    }
    const timeoutMs = Math.max(0, Math.min(numberValue(args.timeout_ms) ?? numberValue(args.timeoutMs) ?? 30_000, 3_600_000));
    const allTargets = targets.length > 0 ? targets : [target!];
    const deadline = Date.now() + timeoutMs;
    const statuses: Record<string, unknown> = {};
    for (const item of allTargets) {
      const record = spawned.get(item);
      if (record) {
        if (timeoutMs > 0) {
          while (Date.now() < deadline) {
            const status = record.status();
            if (status.status !== "running") break;
            await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
          }
        }
        const status = record.status();
        statuses[item] = status;
        if (status.status !== "running") {
          try {
            statuses[`${item}:result`] = await record.join();
          } catch (error) {
            statuses[`${item}:error`] =
              error instanceof Error ? error.message : String(error);
          }
        }
        continue;
      }
      const sessionOrError = getSessionOrError(opts);
      if (!("conversationId" in sessionOrError)) return sessionOrError;
      const { control } = ensureAgentControl(sessionOrError);
      const listed = control.listAgents();
      statuses[item] =
        listed.find((agent) => agent.agentName === item) ??
        { status: "not_found" };
    }
    return json({ status: statuses });
  };

  const closeAgent = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const target = parseTarget(args);
    if (!target) return json({ error: "target is required" }, true);
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const agentId = resolveAgentId(sessionOrError, target);
    const previous =
      spawned.get(target)?.status() ??
      spawned.get(agentId)?.status() ??
      { status: "unknown" };
    await control.shutdown(agentId, stringValue(args.reason) ?? "closed_by_tool");
    return json({ previous_status: previous });
  };

  const sendInput = async (
    args: Record<string, unknown>,
    triggerTurn: boolean,
  ): Promise<ToolResult> => {
    const target = parseTarget(args);
    const message =
      stringValue(args.message) ??
      stringValue(args.input) ??
      stringValue(args.prompt);
    if (!target || !message) {
      return json({ error: "target and message are required" }, true);
    }
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const agentId = resolveAgentId(sessionOrError, target);
    if (triggerTurn) {
      await control.sendInput(agentId, message);
    } else {
      await control.appendMessage(agentId, message);
    }
    return json({ accepted: true, target: agentId, trigger_turn: triggerTurn });
  };

  const listAgents = async (
    args: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const sessionOrError = getSessionOrError(opts);
    if (!("conversationId" in sessionOrError)) return sessionOrError;
    const { control } = ensureAgentControl(sessionOrError);
    const roleName = stringValue(args.role) ?? stringValue(args.agent_type);
    const pathPrefix = stringValue(args.path_prefix) ?? stringValue(args.pathPrefix);
    return json({
      agents: control.listAgents({
        ...(roleName !== undefined ? { roleName } : {}),
        ...(pathPrefix !== undefined ? { pathPrefix: pathPrefix as AgentPath } : {}),
      }),
    });
  };

  const agentSchema = {
    type: "object",
    properties: {
      message: { type: "string" },
      prompt: { type: "string" },
      task: { type: "string" },
      items: { type: "array" },
      agent_type: { type: "string" },
      role: { type: "string" },
      fork_context: { type: "boolean" },
      run_in_background: { type: "boolean" },
    },
    additionalProperties: true,
  };

  return [
    {
      name: "spawn_agent",
      description:
        "Spawn a background agent for a bounded task. Returns an agent id, path, and nickname.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "spawn", "delegate", "subagent"],
      }),
      requiresApproval: true,
      inputSchema: agentSchema,
      execute: (args) => spawn(args, "spawn_agent"),
    },
    {
      name: "Agent",
      description:
        "Compatibility alias for spawn_agent. Prefer spawn_agent for new AgenC calls.",
      metadata: toolMetadata("agent", {
        mutating: true,
        deferred: true,
        keywords: ["agent", "task", "compatibility"],
      }),
      requiresApproval: true,
      inputSchema: agentSchema,
      execute: (args) => spawn(args, "Agent"),
    },
    {
      name: "wait_agent",
      description:
        "Wait for one or more spawned agents to reach a terminal status and return their current status.",
      metadata: toolMetadata("agent", { keywords: ["agent", "wait", "status"] }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          targets: { type: "array", items: { type: "string" } },
          timeout_ms: { type: "number" },
        },
        additionalProperties: false,
      },
      execute: waitForAgent,
    },
    {
      name: "TaskOutput",
      description:
        "Compatibility alias for wait_agent that returns the latest known task or agent status.",
      metadata: toolMetadata("agent", {
        deferred: true,
        keywords: ["agent", "task", "output"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          agent_id: { type: "string" },
          timeout_ms: { type: "number" },
        },
        additionalProperties: true,
      },
      execute: waitForAgent,
    },
    {
      name: "close_agent",
      description: "Close a spawned agent and its descendants.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "close", "stop"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          agent_id: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: closeAgent,
    },
    {
      name: "TaskStop",
      description:
        "Compatibility alias for close_agent. Prefer close_agent for new AgenC calls.",
      metadata: toolMetadata("agent", {
        mutating: true,
        deferred: true,
        keywords: ["agent", "task", "stop"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string" },
          agent_id: { type: "string" },
          reason: { type: "string" },
        },
        additionalProperties: true,
      },
      execute: closeAgent,
    },
    {
      name: "send_input",
      description: "Send input to a spawned agent and wake it for another turn.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "input", "message"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
          input: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: (args) => sendInput(args, true),
    },
    {
      name: "send_message",
      description:
        "Queue a message for a spawned agent without forcing an immediate turn.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "message", "mailbox"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: (args) => sendInput(args, false),
    },
    {
      name: "SendMessage",
      description:
        "Compatibility alias for send_message. Prefer send_message for new AgenC calls.",
      metadata: toolMetadata("agent", {
        mutating: true,
        deferred: true,
        keywords: ["agent", "message", "compatibility"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          target: { type: "string" },
          message: { type: "string" },
        },
        additionalProperties: true,
      },
      execute: (args) => sendInput(args, false),
    },
    {
      name: "resume_agent",
      description:
        "Report whether an agent is known to the live runtime. Rollout-backed rehydration is used when the session has the required metadata.",
      metadata: toolMetadata("agent", {
        mutating: true,
        keywords: ["agent", "resume"],
      }),
      inputSchema: {
        type: "object",
        properties: { target: { type: "string" }, agent_id: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const target = parseTarget(args);
        if (!target) return json({ error: "target is required" }, true);
        const record = spawned.get(target);
        if (record) {
          return json({
            status: record.status(),
            agent_id: record.threadId,
            agent_path: record.agentPath,
            nickname: record.nickname,
          });
        }
        return json({ status: "not_found", target });
      },
    },
    {
      name: "list_agents",
      description: "List live agents known to the current session.",
      metadata: toolMetadata("agent", { keywords: ["agent", "list", "status"] }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          role: { type: "string" },
          agent_type: { type: "string" },
          path_prefix: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: listAgents,
    },
    {
      name: "TeamCreate",
      description:
        "Compatibility helper that launches several background agents and groups their ids in this session.",
      metadata: toolMetadata("agent", {
        mutating: true,
        deferred: true,
        keywords: ["team", "swarm", "agent"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          team_name: { type: "string" },
          agents: { type: "array" },
        },
        required: ["agents"],
        additionalProperties: true,
      },
      execute: async (args) => {
        const agents = Array.isArray(args.agents) ? args.agents : [];
        if (agents.length === 0) return json({ error: "agents is required" }, true);
        const launched: unknown[] = [];
        for (const agent of agents) {
          if (typeof agent !== "object" || agent === null) continue;
          const result = await spawn(agent as Record<string, unknown>, "TeamCreate");
          launched.push(JSON.parse(result.content));
        }
        return json({
          team_name: stringValue(args.team_name) ?? `team-${randomUUID()}`,
          agents: launched,
        });
      },
    },
    {
      name: "TeamDelete",
      description:
        "Compatibility helper that closes the listed agents for a session-local team.",
      metadata: toolMetadata("agent", {
        mutating: true,
        deferred: true,
        keywords: ["team", "swarm", "agent", "close"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          targets: { type: "array", items: { type: "string" } },
        },
        additionalProperties: true,
      },
      execute: async (args) => {
        const targets = stringArray(args.targets);
        const closed: unknown[] = [];
        for (const target of targets) {
          const result = await closeAgent({ target });
          closed.push(JSON.parse(result.content));
        }
        return json({ closed });
      },
    },
  ];
}

function createMcpResourceTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const listTool = (name: string): Tool => ({
      name,
      description: "List available resources from configured MCP servers.",
      metadata: toolMetadata("mcp", {
        deferred: true,
        keywords: ["mcp", "resource", "list"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const sessionOrError = getSessionOrError(opts);
        if (!("conversationId" in sessionOrError)) return sessionOrError;
        const server = stringValue(args.server);
        const resources =
          server !== undefined
            ? await sessionOrError.services.mcpManager.getResourcesByServer?.(server)
            : await sessionOrError.services.mcpManager.getResources?.();
        if (resources === undefined) {
          return json({ error: "MCP resource listing is not available" }, true);
        }
        return json({ resources });
      },
    });
  const readTool = (name: string): Tool => ({
      name,
      description: "Read a specific MCP resource by server and URI.",
      metadata: toolMetadata("mcp", {
        deferred: true,
        keywords: ["mcp", "resource", "read"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          server: { type: "string" },
          uri: { type: "string" },
          resource: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const sessionOrError = getSessionOrError(opts);
        if (!("conversationId" in sessionOrError)) return sessionOrError;
        const server = stringValue(args.server);
        const uri = stringValue(args.uri) ?? stringValue(args.resource);
        if (!server || !uri) {
          return json({ error: "server and uri are required" }, true);
        }
        const resource = await sessionOrError.services.mcpManager.readResource?.(
          `mcp.${server}.${uri}`,
        );
        if (resource === undefined) {
          return json({ error: "MCP resource reading is not available" }, true);
        }
        if (resource === null) {
          return json({ error: `resource not found: ${server} ${uri}` }, true);
        }
        return json({ resource });
      },
    });
  return [
    listTool("ListMcpResourcesTool"),
    readTool("ReadMcpResourceTool"),
    listTool("ListMcpResources"),
    readTool("ReadMcpResource"),
  ];
}

function createSkillTool(opts: ModelFacingToolOptions): Tool {
  return {
    name: "Skill",
    description:
      "Load a local AgenC skill by name and return its instructions for this turn.",
    metadata: toolMetadata("skill", {
      keywords: ["skill", "instructions", "capability"],
    }),
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        skill: { type: "string" },
        name: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const skillName = stringValue(args.skill) ?? stringValue(args.name);
      if (!skillName) return json({ error: "skill is required" }, true);
      const sessionOrError = getSessionOrError(opts);
      if (!("conversationId" in sessionOrError)) return sessionOrError;
      const outcome = await sessionOrError.services.skillsManager.skillsForConfig({}, null);
      const skill = outcome.availableSkills?.find((entry) => entry.name === skillName);
      if (!skill) {
        return json({
          error: `skill not found: ${skillName}`,
          available: outcome.availableSkills?.map((entry) => entry.name) ?? [],
        }, true);
      }
      const content = await readFile(skill.path, "utf8");
      return json({
        skill: skill.name,
        description: skill.description,
        path: skill.path,
        scope: skill.scope,
        content,
      });
    },
  };
}

function createWebTools(opts: ModelFacingToolOptions): readonly Tool[] {
  return [
    {
      name: "WebFetch",
      description:
        "Fetch an HTTPS URL and return readable text content plus status and final URL.",
      metadata: toolMetadata("web", {
        keywords: ["web", "fetch", "url", "http"],
      }),
      isReadOnly: true,
      concurrencyClass: { kind: "shared_read" },
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string" },
          prompt: { type: "string" },
          timeout_ms: { type: "number" },
          max_chars: { type: "number" },
        },
        required: ["url"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const url = stringValue(args.url);
        if (!url) return json({ error: "url is required" }, true);
        const normalized = normalizeUrl(url);
        const response = await fetchWithTimeout(
          normalized,
          numberValue(args.timeout_ms) ?? DEFAULT_TIMEOUT_MS,
        );
        const contentType = response.headers.get("content-type") ?? "";
        const raw = await response.text();
        const body = contentType.includes("html") ? htmlToText(raw) : raw;
        const maxChars = Math.max(
          1_000,
          Math.min(numberValue(args.max_chars) ?? MAX_FETCH_CHARS, MAX_FETCH_CHARS),
        );
        const textBody =
          body.length > maxChars
            ? `${body.slice(0, maxChars)}\n\n[truncated ${body.length - maxChars} chars]`
            : body;
        return json({
          status: response.status,
          ok: response.ok,
          url: normalized,
          final_url: response.url,
          content_type: contentType,
          prompt: stringValue(args.prompt),
          content: textBody,
        }, response.ok ? undefined : true);
      },
    },
    {
      name: "WebSearch",
      description:
        "Search the web for current information and return result titles, URLs, and snippets.",
      metadata: toolMetadata("web", {
        keywords: ["web", "search", "current", "sources"],
      }),
      isReadOnly: true,
      concurrencyClass: { kind: "shared_read" },
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          allowed_domains: { type: "array", items: { type: "string" } },
          blocked_domains: { type: "array", items: { type: "string" } },
          max_results: { type: "number" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const query = stringValue(args.query);
        if (!query) return json({ error: "query is required" }, true);
        const endpoint = stringValue(opts.env?.AGENC_WEB_SEARCH_ENDPOINT);
        const maxResults = Math.max(
          1,
          Math.min(numberValue(args.max_results) ?? MAX_SEARCH_RESULTS, MAX_SEARCH_RESULTS),
        );
        const searchUrl =
          endpoint !== undefined
            ? `${endpoint}${endpoint.includes("?") ? "&" : "?"}q=${encodeURIComponent(query)}`
            : `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
        const response = await fetchWithTimeout(searchUrl);
        const raw = (await response.json()) as Record<string, unknown>;
        const related = Array.isArray(raw.RelatedTopics) ? raw.RelatedTopics : [];
        const results = related
          .flatMap((entry): Array<Record<string, unknown>> => {
            if (entry && typeof entry === "object" && Array.isArray((entry as Record<string, unknown>).Topics)) {
              return (entry as { Topics: Array<Record<string, unknown>> }).Topics;
            }
            return entry && typeof entry === "object"
              ? [entry as Record<string, unknown>]
              : [];
          })
          .map((entry) => ({
            title: stringValue(entry.Text)?.split(" - ")[0] ?? stringValue(entry.Result) ?? "",
            url: stringValue(entry.FirstURL) ?? "",
            snippet: stringValue(entry.Text) ?? "",
          }))
          .filter((entry) => entry.url.length > 0)
          .slice(0, maxResults);
        return json({
          query,
          source: endpoint !== undefined ? endpoint : "duckduckgo_instant_answer",
          results,
          answer: stringValue(raw.AbstractText),
          heading: stringValue(raw.Heading),
        });
      },
    },
  ];
}

function createNotebookEditTool(opts: ModelFacingToolOptions): Tool {
  return {
    name: "NotebookEdit",
    description:
      "Edit Jupyter notebook cells by cell id or insertion point. Requires a .ipynb file in the workspace.",
    metadata: toolMetadata("coding", {
      mutating: true,
      deferred: true,
      keywords: ["notebook", "ipynb", "edit"],
    }),
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        notebook_path: { type: "string" },
        cell_id: { type: "string" },
        new_source: { type: "string" },
        cell_type: { type: "string", enum: ["code", "markdown"] },
        edit_mode: { type: "string", enum: ["replace", "insert", "delete"] },
      },
      required: ["notebook_path"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const notebookPath = stringValue(args.notebook_path);
      if (!notebookPath) return json({ error: "notebook_path is required" }, true);
      const editMode = stringValue(args.edit_mode) ?? "replace";
      const filePath = resolveWorkspacePath(opts, notebookPath);
      if (extname(filePath) !== ".ipynb") {
        return json({ error: "File must be a Jupyter notebook (.ipynb)" }, true);
      }
      const original = await readFile(filePath, "utf8");
      const notebook = JSON.parse(original) as {
        cells?: Array<Record<string, unknown>>;
        metadata?: Record<string, unknown>;
      };
      if (!Array.isArray(notebook.cells)) {
        return json({ error: "Notebook has no cells array" }, true);
      }
      const cellId = stringValue(args.cell_id);
      const index =
        cellId !== undefined
          ? notebook.cells.findIndex((cell) => cell.id === cellId)
          : editMode === "insert"
            ? -1
            : 0;
      if (editMode !== "insert" && index < 0) {
        return json({ error: `cell not found: ${cellId ?? "(first cell)"}` }, true);
      }
      const newSource = typeof args.new_source === "string" ? args.new_source : "";
      if (editMode === "delete") {
        notebook.cells.splice(index, 1);
      } else if (editMode === "insert") {
        const newCell = {
          cell_type: stringValue(args.cell_type) ?? "code",
          id: randomUUID().slice(0, 8),
          metadata: {},
          source: newSource.endsWith("\n") ? newSource : `${newSource}\n`,
          ...(stringValue(args.cell_type) === "markdown"
            ? {}
            : { execution_count: null, outputs: [] }),
        };
        notebook.cells.splice(index + 1, 0, newCell);
      } else {
        const cell = notebook.cells[index]!;
        cell.source = newSource.endsWith("\n") ? newSource : `${newSource}\n`;
        if (stringValue(args.cell_type) !== undefined) {
          cell.cell_type = stringValue(args.cell_type);
        }
      }
      const updated = `${JSON.stringify(notebook, null, 1)}\n`;
      await writeFile(filePath, updated, "utf8");
      return json({
        notebook_path: filePath,
        cell_id: cellId,
        edit_mode: editMode,
        new_source: newSource,
        original_file: original,
        updated_file: updated,
      });
    },
  };
}

function createLspTool(opts: ModelFacingToolOptions): Tool {
  const codeIntel = new CodeIntelManager({
    persistenceRootDir: opts.agencHome ?? opts.workspaceRoot,
  });
  return {
    name: "LSP",
    description:
      "Inspect code with AgenC's semantic index and lightweight diagnostics.",
    metadata: toolMetadata("coding", {
      deferred: true,
      keywords: ["lsp", "diagnostics", "definition", "references"],
    }),
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["diagnostics", "definition", "references", "symbols"],
        },
        file_path: { type: "string" },
        symbol: { type: "string" },
        query: { type: "string" },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const operation = stringValue(args.operation);
      if (operation === "diagnostics") {
        const filePath = stringValue(args.file_path);
        if (!filePath) return json({ error: "file_path is required" }, true);
        const resolved = resolveWorkspacePath(opts, filePath);
        const exists = existsSync(resolved);
        const fileStat = exists ? await stat(resolved) : null;
        return json({
          file_path: resolved,
          diagnostics: exists && fileStat?.isFile() ? [] : [{
            severity: "error",
            message: "File not found",
          }],
          note:
            "No language server is configured in this runtime; diagnostics are limited to file availability.",
        });
      }
      const query = stringValue(args.symbol) ?? stringValue(args.query);
      if (!query) return json({ error: "symbol or query is required" }, true);
      const filePath = stringValue(args.file_path);
      if (operation === "definition") {
        const definition = await codeIntel.getDefinition({
          workspaceRoot: opts.workspaceRoot,
          symbolName: query,
          ...(filePath !== undefined
            ? { filePath: resolveWorkspacePath(opts, filePath) }
            : {}),
        });
        return json({
          operation,
          query,
          definition:
            definition == null
              ? null
              : {
                  ...definition,
                  filePath: toRelativeWorkspacePath(
                    opts.workspaceRoot,
                    definition.filePath,
                  ),
                },
        });
      }
      if (operation === "references") {
        const references = await codeIntel.getReferences({
          workspaceRoot: opts.workspaceRoot,
          symbolName: query,
          ...(filePath !== undefined
            ? { filePath: resolveWorkspacePath(opts, filePath) }
            : {}),
          maxResults: 100,
        });
        return json({
          operation,
          query,
          references: references.map((entry) => ({
            ...entry,
            filePath: toRelativeWorkspacePath(opts.workspaceRoot, entry.filePath),
          })),
        });
      }
      const symbols = await codeIntel.searchSymbols({
        workspaceRoot: opts.workspaceRoot,
        query,
        maxResults: 100,
      });
      return json({
        operation,
        query,
        symbols: symbols.map((symbol) => ({
          ...symbol,
          filePath: toRelativeWorkspacePath(opts.workspaceRoot, symbol.filePath),
        })),
      });
    },
  };
}

function createPlanAndMessageTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const sendMessage = (name: string): Tool => ({
    name,
    description:
      "Send a concise visible progress message to the user during a long-running task.",
    metadata: toolMetadata("operator", {
      keywords: ["brief", "message", "user", "progress"],
    }),
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    execute: async (args) => {
      const message = stringValue(args.message);
      if (!message) return json({ error: "message is required" }, true);
      const session = opts.getSession();
      session?.emit({
        id: session.nextInternalSubId(),
        msg: { type: "agent_message", payload: { message } },
      });
      return json({ sent: true, message });
    },
  });

  return [
    {
      name: "VerifyPlanExecution",
      description:
        "Compare the current approved plan with a progress summary and report likely gaps before continuing.",
      metadata: toolMetadata("planning", {
        keywords: ["plan", "verify", "execution"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          progress: { type: "string" },
          completed: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const session = opts.getSession();
        const planPath = join(stateRoot(opts), "plans", `${session?.conversationId ?? "default"}.md`);
        let plan = "";
        try {
          plan = await readFile(planPath, "utf8");
        } catch {
          plan = "";
        }
        const progress = stringValue(args.progress) ?? "";
        const completed = stringArray(args.completed);
        return json({
          plan_available: plan.length > 0,
          plan_path: planPath,
          plan,
          progress,
          completed,
          reminder:
            "Continue only if the next action matches the approved plan or the user has approved a plan change.",
        });
      },
    },
    sendMessage("Brief"),
    sendMessage("SendUserMessage"),
  ];
}

function createTaskTools(opts: ModelFacingToolOptions): readonly Tool[] {
  const saveTasks = async (tasks: readonly StoredTask[]): Promise<void> => {
    const state = await readState(opts);
    await writeState(opts, { ...state, tasks });
  };

  return [
    {
      name: "TaskCreate",
      description: "Create a durable AgenC task in the local task list.",
      metadata: toolMetadata("task", {
        mutating: true,
        deferred: true,
        keywords: ["task", "create", "todo"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          subject: { type: "string" },
          description: { type: "string" },
          activeForm: { type: "string" },
          metadata: { type: "object" },
        },
        required: ["subject"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const subject = stringValue(args.subject);
        if (!subject) return json({ error: "subject is required" }, true);
        const state = await readState(opts);
        const now = new Date().toISOString();
        const task: StoredTask = {
          id: `task-${randomUUID()}`,
          subject,
          description: stringValue(args.description) ?? "",
          ...(stringValue(args.activeForm) !== undefined
            ? { activeForm: stringValue(args.activeForm) }
            : {}),
          status: "pending",
          blocks: [],
          blockedBy: [],
          ...(typeof args.metadata === "object" && args.metadata !== null
            ? { metadata: args.metadata as Record<string, unknown> }
            : {}),
          createdAt: now,
          updatedAt: now,
        };
        await writeState(opts, { ...state, tasks: [...state.tasks, task] });
        return json({ task });
      },
    },
    {
      name: "TaskGet",
      description: "Retrieve a durable AgenC task by id.",
      metadata: toolMetadata("task", {
        deferred: true,
        keywords: ["task", "get"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: { taskId: { type: "string" }, task_id: { type: "string" } },
        additionalProperties: false,
      },
      execute: async (args) => {
        const taskId = stringValue(args.taskId) ?? stringValue(args.task_id);
        if (!taskId) return json({ error: "taskId is required" }, true);
        const state = await readState(opts);
        return json({ task: state.tasks.find((task) => task.id === taskId) ?? null });
      },
    },
    {
      name: "TaskUpdate",
      description: "Update a durable AgenC task.",
      metadata: toolMetadata("task", {
        mutating: true,
        deferred: true,
        keywords: ["task", "update"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          task_id: { type: "string" },
          subject: { type: "string" },
          description: { type: "string" },
          activeForm: { type: "string" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed", "cancelled"],
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const taskId = stringValue(args.taskId) ?? stringValue(args.task_id);
        if (!taskId) return json({ error: "taskId is required" }, true);
        const state = await readState(opts);
        let updated: StoredTask | null = null;
        const tasks = state.tasks.map((task) => {
          if (task.id !== taskId) return task;
          updated = {
            ...task,
            ...(stringValue(args.subject) !== undefined ? { subject: stringValue(args.subject)! } : {}),
            ...(stringValue(args.description) !== undefined ? { description: stringValue(args.description)! } : {}),
            ...(stringValue(args.activeForm) !== undefined ? { activeForm: stringValue(args.activeForm)! } : {}),
            ...(stringValue(args.status) !== undefined
              ? { status: stringValue(args.status)! as StoredTask["status"] }
              : {}),
            updatedAt: new Date().toISOString(),
          };
          return updated;
        });
        if (updated === null) return json({ error: `task not found: ${taskId}` }, true);
        await saveTasks(tasks);
        return json({ task: updated });
      },
    },
    {
      name: "TaskList",
      description: "List durable AgenC tasks.",
      metadata: toolMetadata("task", {
        deferred: true,
        keywords: ["task", "list"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const state = await readState(opts);
        const status = stringValue(args.status);
        return json({
          tasks:
            status !== undefined
              ? state.tasks.filter((task) => task.status === status)
              : state.tasks,
        });
      },
    },
  ];
}

function validateCron(schedule: string): boolean {
  return schedule.trim().split(/\s+/).length === 5;
}

function createCronAndWorkflowTools(opts: ModelFacingToolOptions): readonly Tool[] {
  return [
    {
      name: "CronCreate",
      description:
        "Register a local scheduled prompt definition. The current runtime records the schedule; an external runner can execute registered jobs.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["cron", "schedule", "workflow"],
      }),
      inputSchema: {
        type: "object",
        properties: {
          cron: { type: "string" },
          schedule: { type: "string" },
          prompt: { type: "string" },
          timezone: { type: "string" },
          durable: { type: "boolean" },
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const schedule = stringValue(args.cron) ?? stringValue(args.schedule);
        const prompt = stringValue(args.prompt);
        if (!schedule || !prompt) {
          return json({ error: "cron/schedule and prompt are required" }, true);
        }
        if (!validateCron(schedule)) {
          return json({ error: "cron expression must have five fields" }, true);
        }
        const state = await readState(opts);
        const cron: StoredCron = {
          id: `cron-${randomUUID()}`,
          schedule,
          prompt,
          ...(stringValue(args.timezone) !== undefined
            ? { timezone: stringValue(args.timezone) }
            : {}),
          durable: boolValue(args.durable) ?? true,
          createdAt: new Date().toISOString(),
        };
        await writeState(opts, { ...state, crons: [...state.crons, cron] });
        return json({ cron });
      },
    },
    {
      name: "CronDelete",
      description: "Delete a local scheduled prompt definition.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["cron", "delete"],
      }),
      inputSchema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const id = stringValue(args.id);
        if (!id) return json({ error: "id is required" }, true);
        const state = await readState(opts);
        const crons = state.crons.filter((cron) => cron.id !== id);
        await writeState(opts, { ...state, crons });
        return json({ deleted: state.crons.length !== crons.length, id });
      },
    },
    {
      name: "CronList",
      description: "List local scheduled prompt definitions.",
      metadata: toolMetadata("workflow", {
        deferred: true,
        keywords: ["cron", "list"],
      }),
      isReadOnly: true,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      execute: async () => json({ crons: (await readState(opts)).crons }),
    },
    {
      name: "WorkflowTool",
      description:
        "Run a named local workflow from .agenc/workflows or AGENC_HOME/workflows.",
      metadata: toolMetadata("workflow", {
        mutating: true,
        deferred: true,
        keywords: ["workflow", "run"],
      }),
      requiresApproval: true,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          args: { type: "object" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const name = stringValue(args.name);
        if (!name) return json({ error: "name is required" }, true);
        const candidates = [
          join(opts.workspaceRoot, ".agenc", "workflows", `${name}.json`),
          join(stateRoot(opts), "workflows", `${name}.json`),
        ];
        const workflowPath = candidates.find((candidate) => existsSync(candidate));
        if (!workflowPath) {
          return json({ error: `workflow not found: ${name}`, searched: candidates }, true);
        }
        const workflow = JSON.parse(await readFile(workflowPath, "utf8")) as {
          command?: string;
          description?: string;
        };
        if (!workflow.command) {
          return json({ error: `workflow ${name} has no command` }, true);
        }
        if (!opts.unifiedExecManager) {
          return json({ error: "unified exec manager is not available" }, true);
        }
        const output = await opts.unifiedExecManager.execCommand({
          cmd: workflow.command,
          workdir: opts.workspaceRoot,
        });
        return {
          content: formatUnifiedExecToolContent(output),
          isError: output.exitCode !== null && output.exitCode !== 0 ? true : undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
        };
      },
    },
  ];
}

function findPowerShell(env: NodeJS.ProcessEnv): string | null {
  const pathEntries = (env.PATH ?? "").split(":");
  for (const dir of pathEntries) {
    for (const exe of ["pwsh", "powershell"]) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return exe;
    }
  }
  return process.platform === "win32" ? "powershell" : null;
}

function createPowerShellTool(opts: ModelFacingToolOptions): readonly Tool[] {
  const env = opts.env ?? process.env;
  const shell = findPowerShell(env);
  if (shell === null || opts.unifiedExecManager === undefined) return [];
  return [
    {
      name: "PowerShell",
      description:
        "Run a PowerShell command through AgenC unified exec. Only available when PowerShell is installed.",
      metadata: toolMetadata("terminal", {
        mutating: true,
        deferred: true,
        keywords: ["powershell", "terminal", "shell"],
      }),
      requiresApproval: true,
      concurrencyClass: { kind: "background_terminal" },
      inputSchema: {
        type: "object",
        properties: {
          command: { type: "string" },
          timeout_ms: { type: "number" },
        },
        required: ["command"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const command = stringValue(args.command);
        if (!command) return json({ error: "command is required" }, true);
        const output = await opts.unifiedExecManager!.execCommand({
          cmd: command,
          shell,
          workdir: opts.workspaceRoot,
          ...(numberValue(args.timeout_ms) !== undefined
            ? { timeoutMs: numberValue(args.timeout_ms) }
            : {}),
        });
        return {
          content: formatUnifiedExecToolContent(output),
          isError: output.exitCode !== null && output.exitCode !== 0 ? true : undefined,
          codeModeResult: unifiedExecCodeModeResult(output),
        };
      },
    },
  ];
}

function createRemoteTriggerTool(opts: ModelFacingToolOptions): Tool {
  return {
    name: "RemoteTrigger",
    description:
      "Inspect local scheduled prompt definitions. Remote hosted trigger management is not enabled in this runtime.",
    metadata: toolMetadata("workflow", {
      deferred: true,
      keywords: ["remote", "trigger", "schedule"],
    }),
    isReadOnly: true,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "get"] },
        trigger_id: { type: "string" },
      },
      additionalProperties: false,
    },
    execute: async (args) => {
      const action = stringValue(args.action) ?? "list";
      const state = await readState(opts);
      if (action === "get") {
        const id = stringValue(args.trigger_id);
        return json({ trigger: state.crons.find((cron) => cron.id === id) ?? null });
      }
      return json({ triggers: state.crons });
    },
  };
}

export function createModelFacingTools(
  opts: ModelFacingToolOptions,
): readonly Tool[] {
  return [
    ...createAgentTools(opts),
    ...createMcpResourceTools(opts),
    createSkillTool(opts),
    ...createWebTools(opts),
    createNotebookEditTool(opts),
    createLspTool(opts),
    ...createPlanAndMessageTools(opts),
    ...createTaskTools(opts),
    ...createCronAndWorkflowTools(opts),
    createRemoteTriggerTool(opts),
    ...createPowerShellTool(opts),
  ];
}
