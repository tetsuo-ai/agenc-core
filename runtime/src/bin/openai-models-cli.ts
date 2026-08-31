/**
 * Headless OpenAI model discovery: `agenc openai-models [--json]`.
 *
 * The desktop's provider pane lists which GPT models the stored credential
 * can actually reach. With a ChatGPT subscription sign-in it asks the
 * ChatGPT backend; with a platform API key (stored or OPENAI_API_KEY) it
 * asks api.openai.com. JSON mode ends with one result record:
 * `{ok, models, authMode}` on success, `{ok:false, error}` otherwise —
 * tokens never appear in the output.
 */

import { createHeadlessEmitters } from "./headless-cli-io.js";
import {
  CHATGPT_BACKEND_BASE_URL,
  chatGptSubscriptionHeaders,
  resolveStoredChatGptSubscriptionCredentials,
} from "../llm/providers/openai/chatgpt-backend.js";
import { readOpenAiOauthCredentials } from "../utils/openAiOauthCredentials.js";
import type { HomeContext } from "../config/home.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";

export type OpenAiModelsCliCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface OpenAiModelsCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly fetchImpl?: FetchLike;
}

export interface OpenAiModelsCliRuntime {
  readonly home: HomeContext;
  readonly environment: ProviderEnvironment;
}

export function parseOpenAiModelsCliArgs(
  argv: readonly string[],
): OpenAiModelsCliCommand | null {
  if (argv[0] !== "openai-models") return null;
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
  if (rest.length === 0) return { kind: "list", json: false };
  if (rest.length === 1 && rest[0] === "--json") {
    return { kind: "list", json: true };
  }
  return {
    kind: "error",
    message: "openai-models accepts only --json or --help",
  };
}

export function formatOpenAiModelsCliHelpText(): string {
  return [
    "Usage:",
    "  agenc openai-models [--json]",
    "",
    "List the OpenAI models the stored credential can reach. A ChatGPT",
    "subscription sign-in queries the ChatGPT backend; a platform API key",
    "(stored, or OPENAI_API_KEY in the environment) queries api.openai.com.",
  ].join("\n");
}

/** Pull model ids out of either backend's listing shape. */
function modelIdsFrom(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const record = payload as Record<string, unknown>;
  const pools = [record.data, record.models].filter(Array.isArray) as
    unknown[][];
  const ids: string[] = [];
  for (const pool of pools) {
    for (const entry of pool) {
      if (typeof entry === "string") {
        ids.push(entry);
        continue;
      }
      if (typeof entry === "object" && entry !== null) {
        const item = entry as Record<string, unknown>;
        const id = [item.id, item.slug, item.model].find(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        );
        if (id !== undefined) ids.push(id);
      }
    }
  }
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id.length > 0))];
}

export async function runOpenAiModelsCli(
  command: OpenAiModelsCliCommand,
  runtime: OpenAiModelsCliRuntime,
  io: OpenAiModelsCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${formatOpenAiModelsCliHelpText()}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatOpenAiModelsCliHelpText()}\n`);
    return 1;
  }

  const { emit, fail } = createHeadlessEmitters(
    command.json,
    io,
    "Model discovery failed",
  );

  const fetchImpl: FetchLike =
    io.fetchImpl ?? (fetch as unknown as FetchLike);
  const stored = readOpenAiOauthCredentials(runtime.home);

  // A subscription sign-in wins, mirroring the provider's credential order.
  const subscription = resolveStoredChatGptSubscriptionCredentials(stored);
  if (stored?.authMode === "chatgpt" && subscription !== undefined) {
    let payload: unknown;
    try {
      // The backend 400s without a client_version; any well-formed value
      // is accepted — it gates the listing shape, not the client build.
      const response = await fetchImpl(
        `${CHATGPT_BACKEND_BASE_URL}/models?client_version=1.0.0`,
        {
          headers: {
            Authorization: `Bearer ${subscription.bearerToken}`,
            "User-Agent": "agenc",
            ...chatGptSubscriptionHeaders(subscription.accountId),
          },
        },
      );
      if (!response.ok) {
        return fail(
          `the ChatGPT backend refused the models request (HTTP ${response.status})`,
        );
      }
      payload = await response.json();
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
    const models = modelIdsFrom(payload);
    if (models.length === 0) {
      return fail("the ChatGPT backend returned no models for this account");
    }
    emit(
      { ok: true, models, authMode: "chatgpt" },
      `ChatGPT subscription models:\n${models.join("\n")}`,
    );
    return 0;
  }

  const apiKey = stored?.apiKey ?? runtime.environment.OPENAI_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return fail(
      "Sign in with ChatGPT or add an OpenAI API key before refreshing models.",
    );
  }
  let payload: unknown;
  try {
    const response = await fetchImpl("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) {
      return fail(`OpenAI refused the models request (HTTP ${response.status})`);
    }
    payload = await response.json();
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  const models = modelIdsFrom(payload);
  if (models.length === 0) {
    return fail("OpenAI returned no models for this credential");
  }
  emit(
    { ok: true, models, authMode: "apiKey" },
    `OpenAI models:\n${models.join("\n")}`,
  );
  return 0;
}
