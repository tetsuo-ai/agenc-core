const DEFAULT_XAI_BASE_URL = "https://api.x.ai/v1";
const DEFAULT_GROK_MODEL = "grok-4-1-fast-reasoning";
const VALIDATION_TIMEOUT_MS = 8_000;

const LEGACY_GROK_MODEL_ALIASES = Object.freeze({
  "grok-4": "grok-4-1-fast-reasoning",
  "grok-4-fast-reasoning": "grok-4-1-fast-reasoning",
  "grok-4-fast-non-reasoning": "grok-4-1-fast-non-reasoning",
  "grok-4.20-experimental-beta-0304-reasoning":
    "grok-4.20-beta-0309-reasoning",
  "grok-4.20-experimental-beta-0304-non-reasoning":
    "grok-4.20-beta-0309-non-reasoning",
  "grok-4.20-multi-agent-experimental-beta-0304":
    "grok-4.20-multi-agent-beta-0309",
  "grok-4.20-0309-reasoning": "grok-4.20-beta-0309-reasoning",
  "grok-4.20-0309-non-reasoning": "grok-4.20-beta-0309-non-reasoning",
  "grok-4.20-multi-agent-0309": "grok-4.20-multi-agent-beta-0309",
  "grok-4.20-reasoning": "grok-4.20-beta-0309-reasoning",
  "grok-4.20-non-reasoning": "grok-4.20-beta-0309-non-reasoning",
  "grok-4.20-multi-agent": "grok-4.20-multi-agent-beta-0309",
  "grok-4.20-beta-latest-reasoning": "grok-4.20-beta-0309-reasoning",
  "grok-4.20-beta-latest-non-reasoning": "grok-4.20-beta-0309-non-reasoning",
  "grok-4.20-multi-agent-beta-latest": "grok-4.20-multi-agent-beta-0309",
});

const KNOWN_GROK_CHAT_MODELS = new Set([
  "grok-4.20-multi-agent-beta-0309",
  "grok-4.20-beta-0309-reasoning",
  "grok-4.20-beta-0309-non-reasoning",
  "grok-4-1-fast-reasoning",
  "grok-4-1-fast-non-reasoning",
  "grok-4-fast-reasoning",
  "grok-4-fast-non-reasoning",
  "grok-code-fast-1",
  "grok-4-0709",
  "grok-3",
  "grok-3-mini",
]);

function normalizeBaseUrl(baseUrl) {
  const raw = String(baseUrl ?? "").trim() || DEFAULT_XAI_BASE_URL;
  return raw.replace(/\/+$/, "");
}

function normalizeGrokModel(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }
  return LEGACY_GROK_MODEL_ALIASES[normalized] ?? normalized;
}

function extractModelIds(payload) {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const record = payload;
  const candidates = [record.data, record.models, record.items, record.results];
  const collected = new Set();

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const entry of candidate) {
      if (typeof entry === "string" && entry.trim().length > 0) {
        collected.add(entry.trim());
        continue;
      }
      if (typeof entry !== "object" || entry === null) continue;
      const id =
        typeof entry.id === "string"
          ? entry.id
          : typeof entry.name === "string"
            ? entry.name
            : typeof entry.model === "string"
              ? entry.model
              : undefined;
      if (id && id.trim().length > 0) {
        collected.add(id.trim());
      }
    }
  }

  return [...collected];
}

export async function validateXaiApiKey(options) {
  const apiKey = String(options?.apiKey ?? "").trim();
  if (apiKey.length === 0) {
    return {
      ok: false,
      message: "xAI API key cannot be empty.",
      availableModels: [],
    };
  }

  const fetchImpl = options?.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

  try {
    const response = await fetchImpl(`${normalizeBaseUrl(options?.baseUrl)}/models`, {
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

    const payload = await response.json();
    const availableModels = extractModelIds(payload)
      .map((value) => normalizeGrokModel(value) ?? value)
      .filter((value, index, array) => array.indexOf(value) === index)
      .filter((value) => KNOWN_GROK_CHAT_MODELS.has(value));

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
