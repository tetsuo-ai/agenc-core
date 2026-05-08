import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  BUILT_IN_PROVIDER_API_KEY_ENVS,
  BUILT_IN_PROVIDER_BASE_URLS,
} from "../../registry/provider-info.js";

export type GitHubProviderConfig = OpenAIProviderConfig;

const GITHUB_COPILOT_HEADERS = Object.freeze({
  "User-Agent": "GitHubCopilotChat/0.26.7",
  "Editor-Version": "vscode/1.99.3",
  "Editor-Plugin-Version": "copilot-chat/0.26.7",
  "Copilot-Integration-Id": "vscode-chat",
} as const);

function buildGitHubHeaders(
  headers: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  return {
    ...GITHUB_COPILOT_HEADERS,
    ...(headers ?? {}),
  };
}

function normalizeGitHubModel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  const lower = trimmed?.toLowerCase();
  if (!trimmed || lower === "github:copilot" || lower === "copilot") {
    return "gpt-4o";
  }
  const prefix = "github:copilot:";
  if (lower?.startsWith(prefix)) {
    return trimmed.slice(prefix.length);
  }
  return trimmed;
}

export class GitHubProvider extends OpenAIProvider {
  constructor(config: GitHubProviderConfig) {
    super({
      ...config,
      providerName: "github",
      apiKeyEnvLabel: BUILT_IN_PROVIDER_API_KEY_ENVS.github,
      useResponsesApi: false,
      baseURL: config.baseURL ?? BUILT_IN_PROVIDER_BASE_URLS.github,
      defaultHeaders: buildGitHubHeaders(config.defaultHeaders),
      model: normalizeGitHubModel(config.model) ?? "gpt-4o",
    });
  }
}
