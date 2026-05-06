import { isEnvTruthy } from "../../utils/envUtils.js";
import {
  collectDoctorReport,
  formatDoctorReport,
} from "../../diagnostics/doctor.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "../types.js";

export async function runDoctorCommand(
  ctx: SlashCommandContext,
): Promise<string> {
  return formatDoctorReport(await collectDoctorReport(ctx));
}

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Run /doctor health checks for the AgenC runtime",
  isEnabled: () => !isEnvTruthy(process.env.DISABLE_DOCTOR_COMMAND),
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: await runDoctorCommand(ctx),
    })),
};

export default doctorCommand;
