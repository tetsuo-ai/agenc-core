import { listKnownGrokModels, normalizeGrokModel } from "../gateway/context-window.js";
import { DEFAULT_GROK_MODEL } from "../gateway/llm-provider-manager.js";
import type { XaiValidationResult } from "./types.js";

const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const VALIDATION_TIMEOUT_MS = 8_000;

function normalizeBaseUrl(baseUrl: string | undefined): string {
  const raw = baseUrl?.trim() || DEFAULT_XAI_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function extractModelIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const record = payload as Record<string, unknown>;
  const candidates = [record.data, record.models, record.items, record.results];
  const collected = new Set<string>();

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        collected.add(entry.trim());
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const value = entry as Record<string, unknown>;
      const id =
        typeof value.id === "string"
          ? value.id
          : typeof value.name === "string"
            ? value.name
            : typeof value.model === "string"
              ? value.model
              : undefined;
      if (id && id.trim().length > 0) {
        collected.add(id.trim());
      }
    }
  }

  return [...collected];
}

export async function validateXaiApiKey(options: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}): Promise<XaiValidationResult> {
  const apiKey = options.apiKey.trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      message: "xAI API key cannot be empty.",
      availableModels: [],
    };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(options.baseUrl)}/models`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      const message =
        response.status === 401 || response.status === 403
          ? "xAI rejected the API key. Double-check it and try again."
          : `xAI returned HTTP ${response.status} during validation.`;
      return {
        ok: false,
        message,
        availableModels: [],
      };
    }

    const payload = (await response.json()) as unknown;
    const knownChatModels = new Set(
      listKnownGrokModels()
        .filter((entry) => entry.contextWindowTokens > 0)
        .map((entry) => entry.id),
    );
    const availableModels = extractModelIds(payload)
      .map((value) => normalizeGrokModel(value) ?? value)
      .filter((value, index, array) => array.indexOf(value) === index)
      .filter((value) => knownChatModels.has(value));

    return {
      ok: true,
      message: "xAI credentials validated.",
      availableModels:
        availableModels.length > 0
          ? availableModels
          : [DEFAULT_GROK_MODEL],
    };
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof Error && error.name === "AbortError"
          ? "xAI validation timed out. Check your network and try again."
          : `Unable to reach xAI: ${error instanceof Error ? error.message : String(error)}`,
      availableModels: [],
    };
  } finally {
    clearTimeout(timeout);
  }
}
