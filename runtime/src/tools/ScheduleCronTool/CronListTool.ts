import { z } from "zod/v4";
import { getProjectRoot } from "../../bootstrap/state.js";
import { buildTool, type ToolDef } from "../Tool.js";
import { cronToHuman } from "../../utils/cron.js";
import { cronRestoreFailureNeedsWarning, listAllCronTasks, listSessionCronTasks } from "../../utils/cronTasks.js";
import { truncate } from "../../utils/format.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { getTeammateContext } from "../../utils/teammateContext.js";
import {
  buildCronListPrompt,
  CRON_LIST_DESCRIPTION,
  CRON_LIST_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from "./prompt.js";
import { renderListResultMessage, renderListToolUseMessage } from "./UI.js";

const inputSchema = lazySchema(() => z.strictObject({}));
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    jobs: z.array(
      z.object({
        id: z.string(),
        cron: z.string(),
        humanSchedule: z.string(),
        prompt: z.string(),
        recurring: z.boolean().optional(),
        durable: z.boolean().optional(),
      }),
    ),
    warning: z.string().optional(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type ListOutput = z.infer<OutputSchema>;

export const CronListTool = buildTool({
  name: CRON_LIST_TOOL_NAME,
  searchHint: "list active cron jobs",
  maxResultSizeChars: 100_000,
  get inputSchema(): InputSchema {
    return inputSchema();
  },
  get outputSchema(): OutputSchema {
    return outputSchema();
  },
  isEnabled() {
    return isKairosCronEnabled();
  },
  isConcurrencySafe() {
    return true;
  },
  isReadOnly() {
    return true;
  },
  async description() {
    return CRON_LIST_DESCRIPTION;
  },
  async prompt() {
    return buildCronListPrompt(isDurableCronEnabled());
  },
  async call(_input, context) {
    const conversationId = context?.sessionId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new Error("CronList requires an active owning conversation");
    }
    let allTasks;
    let warning: string | undefined;
    try {
      allTasks = await listAllCronTasks(getProjectRoot(), conversationId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code !== "DESCRIPTOR_UNSUPPORTED") throw error;
      allTasks = listSessionCronTasks(conversationId);
      if (await cronRestoreFailureNeedsWarning(error, getProjectRoot())) {
        warning = "Durable jobs are unavailable on this host; only session jobs are listed.";
      }
    }
    // Teammates only see their own crons; team lead (no ctx) sees all.
    const ctx = getTeammateContext();
    const tasks = ctx
      ? allTasks.filter((t) => t.agentId === ctx.agentId)
      : allTasks;
    const jobs = tasks.map((t) => ({
      id: t.id,
      cron: t.cron,
      humanSchedule: cronToHuman(t.cron),
      prompt: t.prompt,
      ...(t.recurring ? { recurring: true } : {}),
      ...(t.durable === false ? { durable: false } : {}),
    }));
    return { data: { jobs, ...(warning ? { warning } : {}) } };
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: "tool_result",
      content: (output.warning ? `${output.warning}\n` : "") +
        (output.jobs.length > 0
          ? output.jobs
              .map(
                (j) =>
                  `${j.id} — ${j.humanSchedule}${j.recurring ? " (recurring)" : " (one-shot)"}${j.durable === false ? " [session-only]" : ""}: ${truncate(j.prompt, 80, true)}`,
              )
              .join("\n")
          : "No scheduled jobs."),
    };
  },
  renderToolUseMessage: renderListToolUseMessage,
  renderToolResultMessage: renderListResultMessage,
} satisfies ToolDef<InputSchema, ListOutput>);
