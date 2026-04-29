import { join, normalize, sep } from "node:path";

import { resolveAgencHome } from "../../planning/plan-files.js";

export type ToolRenderTone =
  | "read"
  | "list"
  | "write"
  | "edit"
  | "search"
  | "exec"
  | "agent"
  | "task"
  | "team"
  | "mcp"
  | "web"
  | "lsp"
  | "schedule"
  | "plan"
  | "skill"
  | "notebook"
  | "generic";

export interface ToolRenderContext {
  readonly toolName?: string;
  readonly toolArgs?: unknown;
  readonly result?: string;
  readonly progress?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly isComplete: boolean;
  readonly isError: boolean;
}

export interface ToolRenderPresentation {
  readonly tone: ToolRenderTone;
  readonly title: string;
  readonly target: string;
  readonly detail?: string;
  readonly preserveResultLines?: boolean;
  readonly hide?: boolean;
}

export interface ToolSpecificRenderer {
  readonly renderToolUseMessage?: (
    ctx: ToolRenderContext,
  ) => Partial<ToolRenderPresentation> | null;
  readonly renderToolResultMessage?: (
    ctx: ToolRenderContext,
  ) => Partial<ToolRenderPresentation> | null;
  readonly renderToolUseErrorMessage?: (
    ctx: ToolRenderContext,
  ) => Partial<ToolRenderPresentation> | null;
}

type ToolNameMatcher = readonly string[];

interface RegisteredToolRenderer {
  readonly names: ToolNameMatcher;
  readonly renderer: ToolSpecificRenderer;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(
  value: unknown,
  keys: readonly string[],
): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim().length > 0) {
      return field.trim();
    }
  }
  return undefined;
}

function compact(value: string, max = 96): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

function safeJsonParse(value: string | undefined): unknown {
  if (value === undefined || value.trim().length === 0) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function parsedResult(ctx: ToolRenderContext): unknown {
  return safeJsonParse(ctx.result);
}

function resultStringField(
  ctx: ToolRenderContext,
  keys: readonly string[],
): string | undefined {
  const parsed = parsedResult(ctx);
  return readStringField(parsed, keys);
}

function readArrayField(value: unknown, keys: readonly string[]): readonly unknown[] {
  if (!isRecord(value)) return [];
  for (const key of keys) {
    const field = value[key];
    if (Array.isArray(field)) return field;
  }
  return [];
}

function pathTarget(ctx: ToolRenderContext): string {
  return (
    readStringField(ctx.toolArgs, [
      "path",
      "file_path",
      "filePath",
      "notebook_path",
      "uri",
      "url",
      "cwd",
    ]) ?? ""
  );
}

function isPlanFilePath(value: string): boolean {
  if (value.trim().length === 0 || !value.endsWith(".md")) return false;
  const normalized = normalize(value);
  const planDir = normalize(join(resolveAgencHome(), "plans"));
  if (normalized.startsWith(`${planDir}${sep}`)) return true;
  return /(?:^|[/\\])\.agenc[/\\]plans[/\\][^/\\]+\.md$/u.test(normalized);
}

function commandTarget(ctx: ToolRenderContext): string {
  return compact(
    readStringField(ctx.toolArgs, ["command", "cmd", "script"]) ??
      ctx.toolName ??
      "command",
    120,
  );
}

function queryTarget(ctx: ToolRenderContext): string {
  return compact(
    readStringField(ctx.toolArgs, [
      "pattern",
      "query",
      "q",
      "glob",
      "url",
      "prompt",
      "message",
      "task",
      "description",
      "subject",
      "title",
    ]) ?? "",
    120,
  );
}

function idTarget(ctx: ToolRenderContext): string {
  return (
    readStringField(ctx.toolArgs, [
      "id",
      "target",
      "task_name",
      "taskName",
      "agent_id",
      "agentId",
      "task_id",
      "taskId",
      "threadId",
      "subId",
      "name",
      "team",
      "path_prefix",
      "pathPrefix",
    ]) ?? ""
  );
}

function mcpTarget(ctx: ToolRenderContext): string {
  const server = readStringField(ctx.toolArgs, ["server", "serverName"]);
  const uri = readStringField(ctx.toolArgs, ["uri", "resourceUri"]);
  if (server && uri) return `${server}:${uri}`;
  return server ?? uri ?? ctx.toolName?.replace(/^mcp[._]/u, "") ?? "MCP";
}

function titleFor(
  base: string,
  ctx: ToolRenderContext,
  actioning: string,
  failed?: string,
): string {
  if (ctx.isError) return failed ?? `${base} Failed`;
  return ctx.isComplete ? base : actioning;
}

function commonResultDetail(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const error = resultStringField(ctx, ["error", "message"]);
  if (ctx.isError && error) return error;
  const summary = resultStringField(ctx, [
    "summary",
    "content",
    "status",
    "result",
    "output",
  ]);
  if (summary) return summary;
  if (isRecord(parsed) || Array.isArray(parsed)) return undefined;
  return ctx.result;
}

function metadataStringField(
  ctx: ToolRenderContext,
  keys: readonly string[],
): string | undefined {
  return readStringField(ctx.metadata, keys);
}

function questionTarget(ctx: ToolRenderContext): string {
  const questions = readArrayField(ctx.toolArgs, ["questions"]);
  const first = questions[0];
  if (isRecord(first)) {
    return compact(
      readStringField(first, ["header", "question"]) ?? "question",
      80,
    );
  }
  return "question";
}

function userAnswerDetail(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const answers =
    readArrayField(parsed, ["answers"]).length > 0
      ? undefined
      : isRecord(parsed)
        ? parsed.answers
        : undefined;
  if (isRecord(answers)) {
    const lines = Object.entries(answers).map(
      ([question, answer]) => `${question} -> ${String(answer)}`,
    );
    if (lines.length > 0) return lines.slice(0, 4).join("\n");
  }
  const text = ctx.result ?? "";
  const match = /User has answered your questions?:\s*(.+?)\.\s*You can now continue/isu.exec(
    text,
  );
  if (match?.[1]) return compact(match[1], 180);
  return commonResultDetail(ctx);
}

function planApprovalDetail(ctx: ToolRenderContext): string | undefined {
  const plan = metadataStringField(ctx, ["plan"]);
  if (plan && plan.trim().length > 0) return plan;
  const text = ctx.result ?? "";
  const marker = /\n## Approved Plan(?: \(edited by user\))?:\n/iu.exec(text);
  if (marker?.index !== undefined) {
    return text.slice(marker.index + marker[0].length).trim();
  }
  const filePath = metadataStringField(ctx, ["filePath", "planFilePath"]);
  if (filePath) return `Plan saved to: ${filePath}`;
  return undefined;
}

function formatTaskRecord(task: Record<string, unknown>, index: number): string {
  const id = readStringField(task, ["id", "taskId", "task_id"]);
  const subject = readStringField(task, ["subject", "title", "name", "content"]);
  const status = readStringField(task, ["status"]);
  const owner = readStringField(task, ["owner"]);
  const unresolvedBlockers = readArrayField(task, [
    "unresolvedBlockers",
    "blockedBy",
  ]).filter((value): value is string => typeof value === "string");
  const blocked =
    unresolvedBlockers.length > 0
      ? ` [blocked by ${unresolvedBlockers.map((idValue) => `#${idValue}`).join(", ")}]`
      : "";
  const ownerSuffix = owner ? ` (@${owner})` : "";
  return [
    id ? `#${id}` : `${index + 1}.`,
    subject ?? "task",
    status ? `(${status})` : "",
  ]
    .filter(Boolean)
    .join(" ")
    .concat(ownerSuffix, blocked);
}

function formatTaskResult(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const tasks = Array.isArray(parsed)
    ? parsed
    : readArrayField(parsed, ["tasks", "items", "results"]);
  if (tasks.length > 0) {
    return tasks
      .slice(0, 8)
      .map((task, index) =>
        isRecord(task) ? formatTaskRecord(task, index) : `${index + 1}. ${String(task)}`,
      )
      .join("\n");
  }
  const task = isRecord(parsed) && isRecord(parsed.task) ? parsed.task : parsed;
  if (isRecord(task) && readStringField(task, ["id", "taskId", "task_id"])) {
    return formatTaskRecord(task, 0);
  }
  const detail = commonResultDetail(ctx);
  if (detail !== undefined) return detail;
  return isRecord(parsed) || Array.isArray(parsed) ? "" : undefined;
}

function agentStatusText(agent: Record<string, unknown>): string {
  const rawStatus = agent.agentStatus ?? agent.status;
  if (!isRecord(rawStatus)) return "unknown";
  const status = readStringField(rawStatus, ["status"]) ?? "unknown";
  const lastMessage = readStringField(rawStatus, ["lastMessage", "error", "reason"]);
  return lastMessage ? `${status}: ${compact(lastMessage, 120)}` : status;
}

function formatAgentList(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const agents = Array.isArray(parsed)
    ? parsed
    : readArrayField(parsed, ["agents", "items", "results"]);
  if (agents.length === 0) return "No agents";
  return agents
    .slice(0, 12)
    .map((agent, index) => {
      if (!isRecord(agent)) return `${index + 1}. ${String(agent)}`;
      const name =
        readStringField(agent, ["agentName", "agent_name", "name", "threadId"]) ??
        `agent ${index + 1}`;
      const message = readStringField(agent, [
        "lastTaskMessage",
        "last_task_message",
        "taskDescription",
      ]);
      const suffix = message ? ` - ${compact(message, 120)}` : "";
      return `${name}: ${agentStatusText(agent)}${suffix}`;
    })
    .join("\n");
}

function formatMcpResources(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const resources = readArrayField(parsed, ["resources", "items", "results"]);
  if (resources.length === 0) return commonResultDetail(ctx);
  return resources
    .slice(0, 10)
    .map((resource) => {
      if (!isRecord(resource)) return String(resource);
      const server = readStringField(resource, ["server", "serverName"]);
      const uri = readStringField(resource, ["uri", "resourceUri"]);
      const name = readStringField(resource, ["name", "title"]);
      return [server, uri ?? name ?? "resource"].filter(Boolean).join(" · ");
    })
    .join("\n");
}

function taskRenderer(base: string, target: (ctx: ToolRenderContext) => string): ToolSpecificRenderer {
  return {
    renderToolUseMessage: (ctx) => ({
      tone: "task",
      title: titleFor(base, ctx, `${base} Running`),
      target: target(ctx),
    }),
    renderToolResultMessage: (ctx) => ({
      detail: formatTaskResult(ctx),
      preserveResultLines: true,
    }),
    renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
  };
}

const MCP_RESOURCE_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "mcp",
    title: titleFor("MCP Resources", ctx, "Loading MCP Resources"),
    target: mcpTarget(ctx),
  }),
  renderToolResultMessage: (ctx) => ({ detail: formatMcpResources(ctx) }),
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};

function agentRenderer(base: string): ToolSpecificRenderer {
  return {
    renderToolUseMessage: (ctx) => ({
      tone: "agent",
      title: titleFor(base, ctx, `${base} Running`),
      target: idTarget(ctx) || queryTarget(ctx),
    }),
    renderToolResultMessage: (ctx) => ({
      detail: commonResultDetail(ctx),
    }),
    renderToolUseErrorMessage: (ctx) => ({
      detail: commonResultDetail(ctx),
    }),
  };
}

const LIST_AGENTS_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "agent",
    title: titleFor("Agents", ctx, "Listing Agents"),
    target: idTarget(ctx),
  }),
  renderToolResultMessage: (ctx) => ({
    detail: formatAgentList(ctx),
    preserveResultLines: true,
  }),
  renderToolUseErrorMessage: (ctx) => ({
    detail: commonResultDetail(ctx),
  }),
};

function simpleRenderer(
  tone: ToolRenderTone,
  base: string,
  target: (ctx: ToolRenderContext) => string,
  actioning = `${base} Running`,
): ToolSpecificRenderer {
  return {
    renderToolUseMessage: (ctx) => ({
      tone,
      title: titleFor(base, ctx, actioning),
      target: target(ctx),
    }),
    renderToolResultMessage: (ctx) => ({
      detail: commonResultDetail(ctx),
    }),
    renderToolUseErrorMessage: (ctx) => ({
      detail: commonResultDetail(ctx),
    }),
  };
}

const READ_RENDERER = simpleRenderer("read", "Read", pathTarget, "Reading");
const LIST_RENDERER = simpleRenderer("list", "List", pathTarget, "Listing");
const WRITE_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => {
    const target = pathTarget(ctx);
    const isPlanFile = isPlanFilePath(target);
    return {
      tone: "write",
      title: isPlanFile
        ? titleFor("Updated Plan", ctx, "Updating Plan", "Plan Update Failed")
        : titleFor("Write", ctx, "Writing"),
      target: isPlanFile ? "" : target,
    };
  },
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};
const EDIT_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => {
    const target = pathTarget(ctx);
    const isPlanFile = isPlanFilePath(target);
    return {
      tone: "edit",
      title: isPlanFile
        ? titleFor("Updated Plan", ctx, "Updating Plan", "Plan Update Failed")
        : titleFor("Edit", ctx, "Editing"),
      target: isPlanFile ? "" : target,
    };
  },
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};
const SEARCH_RENDERER = simpleRenderer("search", "Search", queryTarget, "Searching");
const BASH_RENDERER = simpleRenderer("exec", "Bash", commandTarget, "Running Bash");
const POWERSHELL_RENDERER = simpleRenderer(
  "exec",
  "PowerShell",
  commandTarget,
  "Running PowerShell",
);

const NOTEBOOK_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "notebook",
    title: titleFor("Notebook Edit", ctx, "Editing Notebook"),
    target: pathTarget(ctx),
  }),
  renderToolResultMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};

const WEB_FETCH_RENDERER = simpleRenderer("web", "Fetch", queryTarget, "Fetching");
const WEB_SEARCH_RENDERER = simpleRenderer("web", "Web Search", queryTarget, "Searching Web");
const LSP_RENDERER = simpleRenderer("lsp", "LSP", pathTarget, "Checking LSP");
const MCP_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "mcp",
    title: titleFor("MCP", ctx, "Calling MCP"),
    target: mcpTarget(ctx),
  }),
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};
const SKILL_RENDERER = simpleRenderer("skill", "Skill", idTarget, "Running Skill");
const VERIFY_PLAN_RENDERER = simpleRenderer(
  "plan",
  "Verify Plan",
  queryTarget,
  "Verifying Plan",
);
const ASK_USER_QUESTION_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "plan",
    title: titleFor("Asked User Question", ctx, "Asking User Question"),
    target: questionTarget(ctx),
  }),
  renderToolResultMessage: (ctx) => ({
    title: "User Answered",
    target: "",
    detail: userAnswerDetail(ctx),
  }),
  renderToolUseErrorMessage: () => ({ detail: undefined }),
};
const EXIT_PLAN_MODE_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "plan",
    title: titleFor("Plan Approved", ctx, "Requesting Plan Approval"),
    target: "",
  }),
  renderToolResultMessage: (ctx) => ({
    detail: planApprovalDetail(ctx),
    preserveResultLines: true,
  }),
  renderToolUseErrorMessage: (ctx) => ({
    title: "Plan Approval Failed",
    detail: commonResultDetail(ctx),
  }),
};
const BRIEF_RENDERER = simpleRenderer("agent", "Brief", queryTarget, "Sending Brief");
const REPL_RENDERER = simpleRenderer("exec", "REPL", commandTarget, "Running REPL");
const WORKFLOW_RENDERER = simpleRenderer(
  "schedule",
  "Workflow",
  idTarget,
  "Running Workflow",
);
const REMOTE_RENDERER = simpleRenderer(
  "agent",
  "Remote Trigger",
  idTarget,
  "Triggering Remote",
);

const REGISTERED_RENDERERS: readonly RegisteredToolRenderer[] = [
  {
    names: ["FileRead", "Read", "ReadFile", "read_file"],
    renderer: READ_RENDERER,
  },
  {
    names: ["ListDir", "ls", "list_dir", "system.listdir", "system.list_dir"],
    renderer: LIST_RENDERER,
  },
  {
    names: ["Write", "FileWrite", "write_file"],
    renderer: WRITE_RENDERER,
  },
  {
    names: ["Edit", "FileEdit", "edit_file"],
    renderer: EDIT_RENDERER,
  },
  {
    names: ["Grep", "Glob", "system.grep", "system.glob", "ToolSearch"],
    renderer: SEARCH_RENDERER,
  },
  {
    names: ["Bash", "Shell", "exec_command", "system.bash", "desktop.bash"],
    renderer: BASH_RENDERER,
  },
  { names: ["PowerShell"], renderer: POWERSHELL_RENDERER },
  { names: ["spawn_agent"], renderer: agentRenderer("Agent") },
  { names: ["list_agents"], renderer: LIST_AGENTS_RENDERER },
  { names: ["wait_agent"], renderer: agentRenderer("Agent Wait") },
  { names: ["close_agent"], renderer: agentRenderer("Agent Close") },
  {
    names: ["send_message", "followup_task"],
    renderer: agentRenderer("Send Message"),
  },
  { names: ["TaskCreate"], renderer: taskRenderer("Task Create", queryTarget) },
  { names: ["TaskGet"], renderer: taskRenderer("Task Get", idTarget) },
  { names: ["TaskUpdate"], renderer: taskRenderer("Task Update", idTarget) },
  { names: ["TaskList"], renderer: taskRenderer("Task List", idTarget) },
  { names: ["Skill"], renderer: SKILL_RENDERER },
  { names: ["NotebookEdit"], renderer: NOTEBOOK_RENDERER },
  { names: ["WebFetch"], renderer: WEB_FETCH_RENDERER },
  { names: ["WebSearch"], renderer: WEB_SEARCH_RENDERER },
  { names: ["LSP"], renderer: LSP_RENDERER },
  {
    names: [
      "ListMcpResourcesTool",
      "ReadMcpResourceTool",
      "ListMcpResources",
      "ReadMcpResource",
    ],
    renderer: MCP_RESOURCE_RENDERER,
  },
  { names: ["CronCreate"], renderer: simpleRenderer("schedule", "Cron Create", idTarget, "Creating Cron") },
  { names: ["CronDelete"], renderer: simpleRenderer("schedule", "Cron Delete", idTarget, "Deleting Cron") },
  { names: ["CronList"], renderer: simpleRenderer("schedule", "Cron List", idTarget, "Listing Crons") },
  { names: ["WorkflowTool"], renderer: WORKFLOW_RENDERER },
  { names: ["RemoteTrigger"], renderer: REMOTE_RENDERER },
  { names: ["Brief", "SendUserMessage"], renderer: BRIEF_RENDERER },
  { names: ["VerifyPlanExecution"], renderer: VERIFY_PLAN_RENDERER },
  { names: ["AskUserQuestion"], renderer: ASK_USER_QUESTION_RENDERER },
  {
    names: ["ExitPlanMode", "workflow.exitPlan"],
    renderer: EXIT_PLAN_MODE_RENDERER,
  },
  { names: ["REPL"], renderer: REPL_RENDERER },
];

function normalizeToolName(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function findRenderer(toolName: string | undefined): ToolSpecificRenderer | null {
  const normalized = normalizeToolName(toolName);
  if (normalized.length === 0) return null;
  if (normalized.startsWith("mcp.") || normalized.startsWith("mcp__")) {
    return MCP_RENDERER;
  }
  for (const entry of REGISTERED_RENDERERS) {
    if (entry.names.some((name) => normalizeToolName(name) === normalized)) {
      return entry.renderer;
    }
  }
  return null;
}

export function renderToolPresentation(
  ctx: ToolRenderContext,
): Partial<ToolRenderPresentation> | null {
  const renderer = findRenderer(ctx.toolName);
  if (renderer === null) return null;
  const useMessage = renderer.renderToolUseMessage?.(ctx) ?? {};
  if (useMessage === null) return null;
  const resultMessage = ctx.isError
    ? renderer.renderToolUseErrorMessage?.(ctx)
    : renderer.renderToolResultMessage?.(ctx);
  if (resultMessage === null) return null;
  return {
    ...useMessage,
    ...(resultMessage ?? {}),
  };
}

export function toolRendererTone(toolName: string | undefined): ToolRenderTone {
  const renderer = findRenderer(toolName);
  if (renderer === READ_RENDERER) return "read";
  if (renderer === LIST_RENDERER) return "list";
  if (renderer === WRITE_RENDERER) return "write";
  if (renderer === EDIT_RENDERER) return "edit";
  if (renderer === SEARCH_RENDERER) return "search";
  if (renderer === BASH_RENDERER || renderer === POWERSHELL_RENDERER) return "exec";
  if (renderer === MCP_RENDERER) return "mcp";
  if (renderer === MCP_RESOURCE_RENDERER) return "mcp";
  if (renderer === WEB_FETCH_RENDERER || renderer === WEB_SEARCH_RENDERER) return "web";
  if (renderer === LSP_RENDERER) return "lsp";
  if (renderer === SKILL_RENDERER) return "skill";
  if (renderer === NOTEBOOK_RENDERER) return "notebook";
  if (renderer === VERIFY_PLAN_RENDERER) return "plan";
  if (renderer === ASK_USER_QUESTION_RENDERER) return "plan";
  if (renderer === EXIT_PLAN_MODE_RENDERER) return "plan";
  if (renderer === WORKFLOW_RENDERER) return "schedule";
  if (renderer === LIST_AGENTS_RENDERER) return "agent";
  return "generic";
}
