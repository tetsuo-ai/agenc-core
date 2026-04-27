export type ToolRenderTone =
  | "read"
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
    ]) ?? "",
    120,
  );
}

function idTarget(ctx: ToolRenderContext): string {
  return (
    readStringField(ctx.toolArgs, [
      "id",
      "target",
      "agent_id",
      "agentId",
      "task_id",
      "taskId",
      "threadId",
      "subId",
      "name",
      "team",
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

function formatTaskList(ctx: ToolRenderContext): string | undefined {
  const parsed = parsedResult(ctx);
  const tasks = Array.isArray(parsed)
    ? parsed
    : readArrayField(parsed, ["tasks", "items", "results"]);
  if (tasks.length === 0) return commonResultDetail(ctx);
  return tasks
    .slice(0, 8)
    .map((task, index) => {
      if (!isRecord(task)) return `${index + 1}. ${String(task)}`;
      const id = readStringField(task, ["id", "taskId", "task_id"]);
      const subject = readStringField(task, ["subject", "title", "name", "content"]);
      const status = readStringField(task, ["status"]);
      return [
        id ? `#${id}` : `${index + 1}.`,
        subject ?? "task",
        status ? `(${status})` : "",
      ]
        .filter(Boolean)
        .join(" ");
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
    renderToolResultMessage: (ctx) => ({ detail: formatTaskList(ctx) }),
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
const WRITE_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "write",
    title: titleFor("Write", ctx, "Writing"),
    target: pathTarget(ctx),
  }),
  renderToolUseErrorMessage: (ctx) => ({ detail: commonResultDetail(ctx) }),
};
const EDIT_RENDERER: ToolSpecificRenderer = {
  renderToolUseMessage: (ctx) => ({
    tone: "edit",
    title: titleFor("Edit", ctx, "Editing"),
    target: pathTarget(ctx),
  }),
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
    names: ["FileRead", "Read", "ReadFile", "read_file", "ListDir", "ls"],
    renderer: READ_RENDERER,
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
  { names: ["Agent"], renderer: agentRenderer("Agent") },
  { names: ["TaskOutput"], renderer: agentRenderer("Task Output") },
  { names: ["TaskStop"], renderer: agentRenderer("Task Stop") },
  { names: ["SendMessage"], renderer: agentRenderer("Send Message") },
  { names: ["TeamCreate"], renderer: simpleRenderer("team", "Team Create", idTarget, "Creating Team") },
  { names: ["TeamDelete"], renderer: simpleRenderer("team", "Team Delete", idTarget, "Deleting Team") },
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
  if (renderer === WORKFLOW_RENDERER) return "schedule";
  return "generic";
}
