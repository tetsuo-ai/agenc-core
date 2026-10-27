import { RUN_RUNTIME_REASONING_EFFORTS } from "../../contracts/run-contracts.js";
import { asRecord } from "../../utils/record.js";
import type { AppState } from "./AppState.js";

/** The bridge publishes these events only after canonical settings reconcile. */
export function syncRuntimeEffortEventToAppState(
  event: unknown,
  setAppState: (updater: (previous: AppState) => AppState) => void,
): void {
  const raw = asRecord(event);
  const message = asRecord(raw?.msg) ?? raw;
  if (message?.type !== "run_runtime_settings_changed") return;
  const payload = asRecord(message.payload);
  const effort = payload?.reasoningEffort;
  if (effort !== null &&
      (typeof effort !== "string" || !RUN_RUNTIME_REASONING_EFFORTS.includes(effort as never))) return;
  const value = effort === null ? undefined : effort as AppState["effortValue"];
  setAppState(previous => previous.effortValue === value ? previous : { ...previous, effortValue: value });
}
