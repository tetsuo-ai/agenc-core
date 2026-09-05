/**
 * Headless native Kimi model discovery: `agenc kimi-models [--json]`.
 *
 * This command is intentionally bound to Moonshot's global endpoint and the
 * canonical MOONSHOT_API_KEY environment ingress. It never accepts credential
 * or endpoint overrides and only reports models supported by AgenC's native
 * Kimi provider.
 */

import { createHeadlessEmitters } from "./headless-cli-io.js";
import type { ProviderEnvironment } from "../llm/provider-options.js";
import { KIMI_CHAT_MODELS } from "../llm/providers/kimi/index.js";
import { BUILT_IN_PROVIDER_BASE_URLS } from "../llm/registry/provider-info.js";

export const KIMI_MODELS_REQUEST_TIMEOUT_MS = 10_000;

export type KimiModelsCliCommand =
  | { readonly kind: "list"; readonly json: boolean }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string };

interface KimiModelsFetchInit {
  readonly headers: Record<string, string>;
  readonly redirect: "error";
  readonly signal: AbortSignal;
}

type FetchLike = (
  url: string,
  init: KimiModelsFetchInit,
) => Promise<{
  readonly ok: boolean;
  readonly status: number;
  readonly json: () => Promise<unknown>;
}>;

export interface KimiModelsCliIo {
  readonly stdout: Pick<NodeJS.WriteStream, "write">;
  readonly stderr: Pick<NodeJS.WriteStream, "write">;
  readonly fetchImpl?: FetchLike;
}

export interface KimiModelsCliRuntime {
  readonly environment: ProviderEnvironment;
}

export function parseKimiModelsCliArgs(
  argv: readonly string[],
): KimiModelsCliCommand | null {
  if (argv[0] !== "kimi-models") return null;
  const rest = argv.slice(1);
  if (rest.includes("--help") || rest.includes("-h")) return { kind: "help" };
  if (rest.length === 0) return { kind: "list", json: false };
  if (rest.length === 1 && rest[0] === "--json") {
    return { kind: "list", json: true };
  }
  return {
    kind: "error",
    message: "kimi-models accepts only --json or --help",
  };
}

export function formatKimiModelsCliHelpText(): string {
  return [
    "Usage:",
    "  agenc kimi-models [--json]",
    "",
    "List the native Kimi models available to MOONSHOT_API_KEY through",
    "Moonshot's fixed global API endpoint.",
  ].join("\n");
}

function parseKimiModelIds(payload: unknown): string[] | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as Record<string, unknown>).data;
  if (!Array.isArray(data)) return null;

  const ids: string[] = [];
  for (const entry of data) {
    if (typeof entry !== "object" || entry === null) return null;
    const id = (entry as Record<string, unknown>).id;
    if (typeof id !== "string" || id.length === 0) return null;
    ids.push(id);
  }

  const available = new Set(ids);
  return KIMI_CHAT_MODELS.filter((id) => available.has(id));
}

function redactError(error: unknown, apiKey: string): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutExactKey = raw.split(apiKey).join("[redacted]");
  const withoutBearer = withoutExactKey.replace(
    /\bBearer\s+[^\s,;]+/giu,
    "Bearer [redacted]",
  );
  return withoutBearer.trim().length > 0
    ? withoutBearer
    : "Kimi model discovery request failed.";
}

export async function runKimiModelsCli(
  command: KimiModelsCliCommand,
  runtime: KimiModelsCliRuntime,
  io: KimiModelsCliIo = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  if (command.kind === "help") {
    io.stdout.write(`${formatKimiModelsCliHelpText()}\n`);
    return 0;
  }
  if (command.kind === "error") {
    io.stderr.write(`agenc: ${command.message}\n`);
    io.stderr.write(`${formatKimiModelsCliHelpText()}\n`);
    return 1;
  }

  const { emit, fail } = createHeadlessEmitters(
    command.json,
    io,
    "Kimi model discovery failed",
  );
  const apiKey = runtime.environment.MOONSHOT_API_KEY?.trim();
  if (apiKey === undefined || apiKey.length === 0) {
    return fail("Add a Kimi API key before refreshing models.");
  }

  const fetchImpl: FetchLike = io.fetchImpl ?? (fetch as unknown as FetchLike);
  let response: Awaited<ReturnType<FetchLike>>;
  try {
    response = await fetchImpl(
      `${BUILT_IN_PROVIDER_BASE_URLS.kimi}/models`,
      {
        headers: { Authorization: `Bearer ${apiKey}` },
        redirect: "error",
        signal: AbortSignal.timeout(KIMI_MODELS_REQUEST_TIMEOUT_MS),
      },
    );
  } catch (error) {
    return fail(`Kimi models request failed: ${redactError(error, apiKey)}`);
  }

  if (!response.ok) {
    return fail(`Kimi refused the models request (HTTP ${response.status}).`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    return fail(
      `Kimi returned a malformed models response: ${redactError(error, apiKey)}`,
    );
  }
  const models = parseKimiModelIds(payload);
  if (models === null) {
    return fail("Kimi returned a malformed models response.");
  }

  emit(
    { ok: true, models },
    models.length === 0
      ? "Kimi models: none available"
      : `Kimi models:\n${models.join("\n")}`,
  );
  return 0;
}
