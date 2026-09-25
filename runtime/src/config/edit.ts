import { join } from "node:path";

import type { Personality } from "./schema.js";
import {
  cloneRecord,
  isPlainRecord,
  type JsonRecord,
} from "./json.js";
import { mutateCanonicalUserConfigSync } from "./update-sync.js";

function configTomlPath(agencHome: string): string {
  return join(agencHome, "config.toml");
}

export class AgenCConfigEditsBuilder {
  private readonly edits: Array<(raw: JsonRecord) => void> = [];

  constructor(private readonly agencHome: string) {}

  setMcpServer(name: string, config: Readonly<Record<string, unknown>>): this {
    this.edits.push((raw) => {
      const existing = isPlainRecord(raw.mcp_servers)
        ? cloneRecord(raw.mcp_servers)
        : {};
      existing[name] = cloneRecord(config);
      raw.mcp_servers = existing;
    });
    return this;
  }

  removeMcpServer(name: string): this {
    this.edits.push((raw) => {
      if (!isPlainRecord(raw.mcp_servers)) return;
      const next = cloneRecord(raw.mcp_servers);
      delete next[name];
      if (Object.keys(next).length === 0) {
        delete raw.mcp_servers;
      } else {
        raw.mcp_servers = next;
      }
    });
    return this;
  }

  setModelSelection(provider: string, model: string): this {
    const normalizedProvider = provider.trim();
    const normalizedModel = model.trim();
    this.edits.push((raw) => {
      if (normalizedProvider.length > 0) {
        raw.model_provider = normalizedProvider;
      }
      if (normalizedModel.length > 0) {
        raw.model = normalizedModel;
      }
      if (normalizedProvider.length > 0 && normalizedModel.length > 0) {
        const providers = isPlainRecord(raw.providers)
          ? cloneRecord(raw.providers)
          : {};
        const existing = isPlainRecord(providers[normalizedProvider])
          ? cloneRecord(
              providers[normalizedProvider] as Record<string, unknown>,
            )
          : {};
        existing.default_model = normalizedModel;
        providers[normalizedProvider] = existing;
        raw.providers = providers;
      }
    });
    return this;
  }

  setCoordinatorMode(enabled: boolean | null): this {
    this.edits.push((raw) => {
      if (enabled === null) {
        delete raw.coordinator_mode;
      } else {
        raw.coordinator_mode = enabled;
      }
    });
    return this;
  }

  setPersonality(personality: Personality | null): this {
    this.edits.push((raw) => {
      if (personality === null) {
        delete raw.personality;
      } else {
        raw.personality = personality;
      }
    });
    return this;
  }

  async apply(): Promise<void> {
    if (this.edits.length === 0) return;
    mutateCanonicalUserConfigSync(configTomlPath(this.agencHome), (raw) => {
      for (const edit of this.edits) edit(raw);
    });
  }
}
