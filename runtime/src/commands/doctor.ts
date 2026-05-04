import { existsSync } from "node:fs";
import type { Session } from "../session/session.js";
import {
  safeExecute,
  type SlashCommand,
  type SlashCommandContext,
  type SlashCommandResult,
} from "./types.js";

export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function nodeMajor(version: string): number {
  return Number.parseInt(version.replace(/^v/, "").split(".")[0] ?? "0", 10);
}

function providerName(session: Session): string {
  const state = session.state.unsafePeek() as {
    sessionConfiguration?: {
      provider?: { slug?: string };
      collaborationMode?: { model?: string };
    };
  };
  const provider = state.sessionConfiguration?.provider?.slug ?? "unknown";
  const model = state.sessionConfiguration?.collaborationMode?.model ?? "unknown";
  return `${provider} / ${model}`;
}

export function collectDoctorChecks(ctx: SlashCommandContext): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  checks.push({
    name: "Node.js",
    ok: nodeMajor(process.version) >= 18,
    detail: process.version,
  });
  checks.push({
    name: "working directory",
    ok: existsSync(ctx.cwd),
    detail: ctx.cwd,
  });
  checks.push({
    name: "AgenC home",
    ok: Boolean(ctx.agencHome ?? ctx.session.services.configStore?.agencHome),
    detail: ctx.agencHome ?? ctx.session.services.configStore?.agencHome ?? "not configured",
  });
  checks.push({
    name: "config store",
    ok: Boolean(ctx.configStore ?? ctx.session.services.configStore),
    detail: (ctx.configStore ?? ctx.session.services.configStore) ? "available" : "missing",
  });
  checks.push({
    name: "provider",
    ok: true,
    detail: providerName(ctx.session),
  });
  return checks;
}

export function formatDoctorReport(checks: readonly DoctorCheck[]): string {
  return [
    "AgenC doctor",
    ...checks.map(check => {
      const mark = check.ok ? "ok" : "warn";
      return `  ${mark.padEnd(4)} ${check.name}: ${check.detail}`;
    }),
  ].join("\n");
}

export const doctorCommand: SlashCommand = {
  name: "doctor",
  description: "Diagnose the AgenC runtime environment",
  immediate: true,
  execute: (ctx: SlashCommandContext): Promise<SlashCommandResult> =>
    safeExecute(async () => ({
      kind: "text",
      text: formatDoctorReport(collectDoctorChecks(ctx)),
    })),
};

export default doctorCommand;
