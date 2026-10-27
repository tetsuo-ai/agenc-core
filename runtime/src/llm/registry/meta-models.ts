/**
 * Meta Model API chat model identities with a reviewed contract.
 *
 * Muse Wonder (`muse-wonder-1.0`) is pay-as-you-go on the Model API. Muse
 * Wonder Full is not: Meta sells it only inside its own Muse Code CLI
 * subscription, so it has no registered identity here.
 * https://dev.meta.ai/docs/models
 */

export const META_MUSE_WONDER_MODEL = "muse-wonder-1.0";

const REGISTERED_META_CHAT_MODEL =
  /(?:^|[/:])(?:muse-spark-(?:1\.3(?:-contributor)?|1\.2(?:-contributor)?|1\.1)|muse-wonder-1\.0)$/i;

// Any Wonder identity, including a later version that is not registered yet.
const META_MUSE_WONDER_FAMILY = /(?:^|[/:])muse-wonder-[^/:]+$/i;

/** Registered Muse chat models: image input, structured output, effort. */
export function isRegisteredMetaChatModel(model: string | undefined): boolean {
  return typeof model === "string" && REGISTERED_META_CHAT_MODEL.test(model.trim());
}

/**
 * Muse Wonder runs on Meta's Responses API. It is the only Meta surface that
 * carries the model's reasoning from one turn to the next (encrypted replay);
 * Chat Completions redacts reasoning for external keys, so every turn of a
 * tool loop there reasons from scratch.
 * https://dev.meta.ai/docs/reasoning
 * https://dev.meta.ai/docs/protocols
 */
export function metaModelUsesResponsesApi(model: string | undefined): boolean {
  return typeof model === "string" && META_MUSE_WONDER_FAMILY.test(model.trim());
}
