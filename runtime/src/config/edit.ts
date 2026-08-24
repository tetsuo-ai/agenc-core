import { join } from "node:path";

import type { BufferConfig, Personality } from "./schema.js";
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

  setBufferEditorConfig(config: BufferConfig): this {
    this.edits.push((raw) => {
      const buffer: JsonRecord = {};
      if (config.provider !== undefined) buffer.provider = config.provider;
      if (config.show_tabs !== undefined) buffer.show_tabs = config.show_tabs;
      if (config.neovim !== undefined) {
        const neovim: JsonRecord = {};
        if (config.neovim.executable !== undefined) {
          neovim.executable = config.neovim.executable;
        }
        if (config.neovim.init !== undefined) neovim.init = config.neovim.init;
        if (config.neovim.discovery_timeout_ms !== undefined) {
          neovim.discovery_timeout_ms = config.neovim.discovery_timeout_ms;
        }
        if (config.neovim.startup_timeout_ms !== undefined) {
          neovim.startup_timeout_ms = config.neovim.startup_timeout_ms;
        }
        if (config.neovim.operation_timeout_ms !== undefined) {
          neovim.operation_timeout_ms = config.neovim.operation_timeout_ms;
        }
        if (config.neovim.cleanup_timeout_ms !== undefined) {
          neovim.cleanup_timeout_ms = config.neovim.cleanup_timeout_ms;
        }
        if (Object.keys(neovim).length > 0) buffer.neovim = neovim;
      }
      if (config.prediction !== undefined) {
        const prediction: JsonRecord = {};
        if (config.prediction.enabled !== undefined) {
          prediction.enabled = config.prediction.enabled;
        }
        if (config.prediction.debounce_ms !== undefined) {
          prediction.debounce_ms = config.prediction.debounce_ms;
        }
        if (config.prediction.timeout_ms !== undefined) {
          prediction.timeout_ms = config.prediction.timeout_ms;
        }
        if (config.prediction.max_output_tokens !== undefined) {
          prediction.max_output_tokens = config.prediction.max_output_tokens;
        }
        if (config.prediction.provider !== undefined) {
          prediction.provider = config.prediction.provider;
        }
        if (config.prediction.model !== undefined) {
          prediction.model = config.prediction.model;
        }
        if (Object.keys(prediction).length > 0) {
          buffer.prediction = prediction;
        }
      }
      raw.buffer = buffer;
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
