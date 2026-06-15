#!/usr/bin/env node

import { isIP } from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const DEFAULT_LOCAL_VLLM_BASE_URL = "http://127.0.0.1:8000/v1";
export const DEFAULT_LOCAL_VLLM_API_KEY = "local-vllm-smoke-key";
export const DEFAULT_LOCAL_VLLM_TIMEOUT_MS = 30_000;

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function parseBoolean(value) {
  if (value === undefined) return false;
  return /^(1|true|yes|on)$/i.test(value);
}

function parsePositiveInteger(value, fallback, label) {
  if (value === undefined || value === "") return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function takeOptionValue(args, option) {
  const value = args.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage: node scripts/check-local-vllm-smoke.mjs [options]",
    "",
    "Checks a local vLLM/OpenAI-compatible endpoint without using remote APIs.",
    "",
    "Options:",
    "  --base-url <url>      Endpoint base URL (default: AGENC_LOCAL_VLLM_BASE_URL or http://127.0.0.1:8000/v1)",
    "  --model <id>          Model ID (default: first /models result)",
    "  --api-key <key>       Bearer token (default: local placeholder)",
    "  --timeout-ms <ms>     Request timeout (default: 30000)",
    "  --models-only         Check /models without sending a chat completion",
    "  --allow-nonlocal      Allow non-loopback base URLs",
    "  --json                Print machine-readable result",
    "  -h, --help            Show this help",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = {
    baseUrl: undefined,
    model: undefined,
    apiKey: undefined,
    timeoutMs: undefined,
    modelsOnly: false,
    allowNonLocal: false,
    json: false,
    help: false,
  };

  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--base-url":
        parsed.baseUrl = takeOptionValue(args, arg);
        break;
      case "--model":
        parsed.model = takeOptionValue(args, arg);
        break;
      case "--api-key":
        parsed.apiKey = takeOptionValue(args, arg);
        break;
      case "--timeout-ms":
        parsed.timeoutMs = takeOptionValue(args, arg);
        break;
      case "--models-only":
        parsed.modelsOnly = true;
        break;
      case "--allow-nonlocal":
        parsed.allowNonLocal = true;
        break;
      case "--json":
        parsed.json = true;
        break;
      case "-h":
      case "--help":
        parsed.help = true;
        break;
      default:
        if (arg?.startsWith("--base-url=")) {
          parsed.baseUrl = arg.slice("--base-url=".length);
        } else if (arg?.startsWith("--model=")) {
          parsed.model = arg.slice("--model=".length);
        } else if (arg?.startsWith("--api-key=")) {
          parsed.apiKey = arg.slice("--api-key=".length);
        } else if (arg?.startsWith("--timeout-ms=")) {
          parsed.timeoutMs = arg.slice("--timeout-ms=".length);
        } else {
          throw new Error(`unknown option: ${arg}`);
        }
    }
  }

  return parsed;
}

export function normalizeBaseUrl(rawBaseUrl) {
  const trimmed = rawBaseUrl.trim().replace(/\/+$/, "");
  const url = new URL(trimmed);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("base URL must use http or https");
  }
  return url.toString().replace(/\/$/, "");
}

export function isLoopbackUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (LOCAL_HOSTNAMES.has(url.hostname)) return true;
  const ipKind = isIP(url.hostname);
  return ipKind === 4 && url.hostname.startsWith("127.");
}

export function assertLocalBaseUrl(baseUrl, allowNonLocal = false) {
  if (allowNonLocal || isLoopbackUrl(baseUrl)) return;
  throw new Error(
    [
      `refusing non-local OpenAI-compatible endpoint: ${baseUrl}`,
      "Use --allow-nonlocal only for an explicitly approved private endpoint.",
    ].join("\n"),
  );
}

export function selectModel(modelsResponse, requestedModel) {
  if (requestedModel && requestedModel.trim().length > 0) {
    return requestedModel.trim();
  }
  const models = Array.isArray(modelsResponse?.data) ? modelsResponse.data : [];
  const firstModel = models
    .map((model) => model?.id)
    .find((id) => typeof id === "string" && id.trim().length > 0);
  if (!firstModel) {
    throw new Error("local endpoint returned no models; pass --model explicitly");
  }
  return firstModel;
}

export function buildChatRequest(model) {
  return {
    model,
    messages: [
      {
        role: "user",
        content: "Reply with exactly LOCAL_VLLM_SMOKE_OK.",
      },
    ],
    temperature: 0,
    max_tokens: 16,
    stream: false,
  };
}

export function resolveSmokeConfig({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    return { help: true };
  }

  const baseUrl = normalizeBaseUrl(
    firstNonEmpty(
      args.baseUrl,
      env.AGENC_LOCAL_VLLM_BASE_URL,
      env.AGENC_LOCAL_OPENAI_BASE_URL,
      env.OPENAI_BASE_URL,
      DEFAULT_LOCAL_VLLM_BASE_URL,
    ),
  );
  const allowNonLocal =
    args.allowNonLocal ||
    parseBoolean(env.AGENC_LOCAL_VLLM_ALLOW_NONLOCAL) ||
    parseBoolean(env.AGENC_LOCAL_OPENAI_ALLOW_NONLOCAL);
  assertLocalBaseUrl(baseUrl, allowNonLocal);

  return {
    help: false,
    baseUrl,
    requestedModel: firstNonEmpty(
      args.model,
      env.AGENC_LOCAL_VLLM_MODEL,
      env.AGENC_LOCAL_OPENAI_MODEL,
      env.AGENC_MODEL,
    ),
    apiKey: firstNonEmpty(
      args.apiKey,
      env.AGENC_LOCAL_VLLM_API_KEY,
      env.AGENC_LOCAL_OPENAI_API_KEY,
      env.OPENAI_COMPATIBLE_API_KEY,
      DEFAULT_LOCAL_VLLM_API_KEY,
    ),
    timeoutMs: parsePositiveInteger(
      args.timeoutMs ?? env.AGENC_LOCAL_VLLM_TIMEOUT_MS,
      DEFAULT_LOCAL_VLLM_TIMEOUT_MS,
      "timeout",
    ),
    modelsOnly: args.modelsOnly || parseBoolean(env.AGENC_LOCAL_VLLM_MODELS_ONLY),
    json: args.json,
    allowNonLocal,
  };
}

function endpointUrl(baseUrl, suffix) {
  return `${baseUrl}${suffix.startsWith("/") ? suffix : `/${suffix}`}`;
}

async function fetchJson(url, {
  apiKey,
  timeoutMs,
  method = "GET",
  body,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      signal: controller.signal,
      headers: {
        Accept: "application/json",
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await response.text();
    let parsed = null;
    if (text.trim().length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`${url} returned non-JSON response: ${text.slice(0, 200)}`);
      }
    }
    if (!response.ok) {
      throw new Error(`${url} returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    return parsed;
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${url} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function assertChatCompletion(response) {
  const choice = Array.isArray(response?.choices) ? response.choices[0] : undefined;
  const content = choice?.message?.content;
  if (typeof content === "string" && content.length > 0) {
    return content;
  }
  throw new Error("chat completion response did not include choices[0].message.content");
}

export async function runSmoke(config) {
  const models = await fetchJson(endpointUrl(config.baseUrl, "/models"), {
    apiKey: config.apiKey,
    timeoutMs: config.timeoutMs,
  });
  const model = selectModel(models, config.requestedModel);
  const result = {
    baseUrl: config.baseUrl,
    model,
    models: Array.isArray(models?.data) ? models.data.length : 0,
    chat: config.modelsOnly ? "skipped" : "passed",
  };

  if (!config.modelsOnly) {
    const chat = await fetchJson(endpointUrl(config.baseUrl, "/chat/completions"), {
      apiKey: config.apiKey,
      timeoutMs: config.timeoutMs,
      method: "POST",
      body: buildChatRequest(model),
    });
    result.sample = assertChatCompletion(chat).slice(0, 120);
  }

  return result;
}

async function main() {
  const config = resolveSmokeConfig();
  if (config.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  const result = await runSmoke(config);
  if (config.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  process.stdout.write(
    [
      "Local vLLM/OpenAI-compatible smoke passed",
      `- baseUrl: ${result.baseUrl}`,
      `- model: ${result.model}`,
      `- models: ${result.models}`,
      `- chat: ${result.chat}`,
      ...(result.sample ? [`- sample: ${result.sample}`] : []),
      "",
    ].join("\n"),
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`local vLLM smoke failed: ${error?.message ?? error}\n`);
      process.exit(1);
    });
}
