/**
 * Short capability tags for a model row in the model picker: what the
 * registered catalog (the provider's published live row when discovery has
 * read it, the bundled snapshot otherwise) says the model takes and returns.
 *
 * @module
 */

import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import { isModelRetired } from "../llm/registry/model-retirement.js";
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../session/cost.js";
import { ollamaMenuModelCapabilities } from "./ollama-menu-models.js";

/** Tags for a model installed on the local Ollama server, from what the server reports. */
function localOllamaTags(model: string): string {
  const capabilities = ollamaMenuModelCapabilities(model);
  if (capabilities === undefined) return "";
  const tags: string[] = [];
  if (capabilities.includes("vision")) tags.push("vision");
  if (capabilities.includes("thinking")) tags.push("thinking");
  if (!capabilities.includes("tools")) tags.push("no tools");
  return tags.join(" · ");
}

/**
 * `now` is the clock a retirement date is read against: "retires <date>"
 * while the date is ahead, "retired <date>" once it has arrived.
 */
export function modelCapabilityTags(provider: string, model: string, now: Date = new Date()): string {
  const entry = resolveRegisteredModelCatalogEntry({ provider, model });
  if (entry === undefined) return provider === "ollama" ? localOllamaTags(model) : "";
  const tags: string[] = [];
  if (entry.inputModalities.includes("image")) tags.push("vision");
  if (entry.supportsThinking === true || entry.supportedReasoningLevels.length > 0) tags.push("thinking");
  if (!entry.supportsToolUse) tags.push("no tools");
  else if (provider === "openrouter") tags.push("tools");
  const cost = resolveModelCostEntry({ provider, model }, DEFAULT_MODEL_COSTS)?.entry;
  if (entry.isFree || (cost?.localZeroCost === true && cost.label === "free")) tags.push("free");
  if (entry.retiresOn !== undefined) {
    tags.push(`${isModelRetired(entry, now) ? "retired" : "retires"} ${entry.retiresOn}`);
  }
  return tags.join(" · ");
}
