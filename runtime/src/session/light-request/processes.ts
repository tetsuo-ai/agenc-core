import { LEAN_FOREGROUND_TIMEOUT_MS } from "./tools.js";

export function leanForegroundLimit(timeoutMs: number | undefined): number {
  return Math.min(timeoutMs ?? LEAN_FOREGROUND_TIMEOUT_MS, LEAN_FOREGROUND_TIMEOUT_MS);
}

export const LEAN_PROCESS_REFUSAL = "Process tools are disabled by light_request_options.process_tools. Enable them for background, detached or interactive commands; foreground commands stop after at most 29 seconds.";
