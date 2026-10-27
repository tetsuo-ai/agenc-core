import { resolveBuiltInProviderSlug } from "../../llm/registry/provider-info.js";
import { asRecord } from "../../utils/record.js";
import type { AppState } from "./AppState.js";

/** Canonical settings also supersede any model previously projected by a command. */
export function syncRuntimeModelEventToAppState(
  event: unknown,
  setAppState: (updater: (previous: AppState) => AppState) => void,
): void {
  const raw = asRecord(event);
  const message = asRecord(raw?.msg) ?? raw;
  if (message?.type !== "run_runtime_settings_changed") return;
  const payload = asRecord(message.payload);
  if (typeof payload?.provider !== "string" || resolveBuiltInProviderSlug(payload.provider) === undefined) return;
  const model = payload.model;
  if (typeof model !== "string" || model.length === 0 || model.trim() !== model) return;
  setAppState(previous => previous.mainLoopModel === model && previous.mainLoopModelForSession === model
    ? previous
    : { ...previous, mainLoopModel: model, mainLoopModelForSession: model });
}
