import { join } from "node:path";
import { isPlainRecord } from "../config/json.js";
import { mutateCanonicalUserConfigSync } from "../config/update-sync.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import { accountDefaultModel, type AccountModelAccess } from "./account-access.js";

/** Save the provider/model pair atomically; existing BYOK choices stay intact. */
export function saveAccountDefaultModel(home: string, access: AccountModelAccess): boolean {
  if (accountDefaultModel(access) === undefined) return false;
  let selected = false;
  mutateCanonicalUserConfigSync(join(home, "config.toml"), raw => {
    const providers = isPlainRecord(raw.providers) ? raw.providers : {};
    const agenc = isPlainRecord(providers.agenc) ? providers.agenc : {};
    const preferred = typeof agenc.default_model === "string" ? agenc.default_model : undefined;
    const model = accountDefaultModel(access, preferred)!;
    raw.providers = { ...providers, agenc: { ...agenc, default_model: model } };
    if (raw.model_provider === undefined || raw.model_provider === "agenc") {
      raw.model_provider = "agenc";
      const selectedModel = accountDefaultModel(access, typeof raw.model === "string" ? raw.model : undefined)!;
      raw.model = selectedModel;
      const entry = resolveRegisteredModelCatalogEntry({ provider: "agenc", model: selectedModel });
      if (entry?.defaultReasoningLevel && !entry.supportedReasoningLevels.some(level => level === raw.reasoning_effort)) {
        raw.reasoning_effort = entry.defaultReasoningLevel;
      }
      selected = true;
    }
  });
  return selected;
}
