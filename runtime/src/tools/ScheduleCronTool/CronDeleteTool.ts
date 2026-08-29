import { z } from "zod/v4";
import { getProjectRoot } from "../../bootstrap/state.js";
import type { ValidationResult } from "../Tool.js";
import { buildTool, type ToolDef } from "../Tool.js";
import {
  getCronFilePath,
  listAllCronTasks,
  removeCronTasks,
} from "../../utils/cronTasks.js";
import { lazySchema } from "../../utils/lazySchema.js";
import { getTeammateContext } from "../../utils/teammateContext.js";
import {
  buildCronDeletePrompt,
  CRON_DELETE_DESCRIPTION,
  CRON_DELETE_TOOL_NAME,
  isDurableCronEnabled,
  isKairosCronEnabled,
} from "./prompt.js";
import { renderDeleteResultMessage, renderDeleteToolUseMessage } from "./UI.js";

const inputSchema = lazySchema(() =>
  z.strictObject({
    id: z.string().describe("Job ID returned by CronCreate."),
  }),
);
type InputSchema = ReturnType<typeof inputSchema>;

const outputSchema = lazySchema(() =>
  z.object({
    id: z.string(),
  }),
);
type OutputSchema = ReturnType<typeof outputSchema>;
export type DeleteOutput = z.infer<OutputSchema>;

export const CronDeleteTool = buildTool({
  name: CRON_DELETE_TOOL_NAME,
  searchHint: "cancel a scheduled cron job",
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
  toAutoClassifierInput(input) {
    return input.id;
  },
  async description() {
    return CRON_DELETE_DESCRIPTION;
  },
  async prompt() {
    return buildCronDeletePrompt(isDurableCronEnabled());
  },
  getPath() {
    return getCronFilePath();
  },
  async validateInput(input, context): Promise<ValidationResult> {
    const conversationId = context?.sessionId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      return {
        result: false,
        message: "CronDelete requires an active owning conversation",
        errorCode: 3,
      };
    }
    const tasks = await listAllCronTasks(getProjectRoot(), conversationId);
    const task = tasks.find((t) => t.id === input.id);
    if (!task) {
      return {
        result: false,
        message: `No scheduled job with id '${input.id}'`,
        errorCode: 1,
      };
    }
    // Teammates may only delete their own crons.
    const ctx = getTeammateContext();
    if (ctx && task.agentId !== ctx.agentId) {
      return {
        result: false,
        message: `Cannot delete cron job '${input.id}': owned by another agent`,
        errorCode: 2,
      };
    }
    return { result: true };
  },
  async call({ id }, context) {
    const conversationId = context?.sessionId;
    if (typeof conversationId !== "string" || conversationId.length === 0) {
      throw new Error("CronDelete requires an active owning conversation");
    }
    await removeCronTasks([id], getProjectRoot(), conversationId);
    return { data: { id } };
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: "tool_result",
      content: `Cancelled job ${output.id}.`,
    };
  },
  renderToolUseMessage: renderDeleteToolUseMessage,
  renderToolResultMessage: renderDeleteResultMessage,
} satisfies ToolDef<InputSchema, DeleteOutput>);
