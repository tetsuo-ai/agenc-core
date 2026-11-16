import { readSessionSelection } from "../session/provider-model-selection.js";

/**
 * "AgenC <provider>/<model>" for the terminal title.
 *
 * `liveModel` is the model the status line shows (it follows /model and
 * runtime settings events). The title used to be computed from the startup
 * props alone, so after a switch it kept naming the model the session
 * started with while the status line named the one in use.
 */
export function terminalTitle(input: {
  readonly session: unknown;
  readonly startupModel?: string | null;
  readonly startupProvider?: string | null;
  readonly liveModel?: string | null;
}): string {
  const startup = input.startupModel?.trim();
  const model = input.liveModel?.trim() || startup;
  if (!model) return "AgenC";
  const selection = readSessionSelection(input.session, { includePending: true });
  // Name a provider only when it is known to serve the shown model: the
  // session's current selection, else the startup provider while the startup
  // model is still the one in use. A stale provider is worse than none.
  const provider = selection.model === model && selection.provider !== "unknown"
    ? selection.provider
    : model === startup
      ? input.startupProvider?.trim()
      : undefined;
  return provider ? `AgenC ${provider}/${model}` : `AgenC ${model}`;
}
