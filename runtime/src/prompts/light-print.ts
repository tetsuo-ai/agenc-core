import type { AgentRuntimeOptions } from "../session/runtime-options.js";
import { DESKTOP_RICH_RENDERER_CLIENT } from "./client-rendering.js";

/** Prompt presentation only; never derives or grants execution authority. */
export function isLightPrintRun(
  options: Partial<Pick<AgentRuntimeOptions, "lightMode" | "nonInteractive" | "simpleMode" | "routineRun">> | undefined,
  environment: Readonly<Record<string, string | undefined>> | undefined,
): boolean {
  return options?.lightMode === true && options.nonInteractive === true &&
    options.simpleMode !== true && options.routineRun !== true &&
    environment?.AGENC_AGENT_SDK_CLIENT_APP !== DESKTOP_RICH_RENDERER_CLIENT;
}

export function lightPrintMemoryContext(project: string, global: string, extra: readonly string[] = []): string {
  return [
    `Memory: global ${global}; project ${project}. Read on request; verify against files; ignore if asked.`,
    ...extra,
  ].join("\n");
}
