import { OpenAIProvider } from "../openai/adapter.js";
import type { OpenAIProviderConfig } from "../openai/types.js";
import {
  getGithubEndpointType,
  normalizeGithubModelForEndpoint,
  shouldUseGithubCopilotResponsesApi,
} from "./model-routing.js";

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

export class GitHubProvider extends OpenAIProvider {
  constructor(config: GitHubProviderConfig) {
    super({
      ...config,
      providerName: "github",
      useResponsesApi: shouldUseGithubCopilotResponsesApi(
        config.model,
        config.baseURL,
      ),
      defaultHeaders: buildGitHubHeaders(config.defaultHeaders),
      model: normalizeGithubModelForEndpoint(
        config.model,
        getGithubEndpointType(config.baseURL),
      ),
    });
  }
}
