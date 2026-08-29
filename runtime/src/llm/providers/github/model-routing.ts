import {
  BUILT_IN_PROVIDER_BASE_URLS,
  BUILT_IN_PROVIDER_DEFAULT_MODELS,
  providerLocalModelIdFromCatalog,
} from "../../registry/provider-info.js";

const GITHUB_COPILOT_HOSTNAME = new URL(
  BUILT_IN_PROVIDER_BASE_URLS.github,
).hostname.toLowerCase();

export type GithubEndpointType = "copilot" | "models" | "custom";

export function getGithubEndpointType(
  baseURL: string | undefined,
): GithubEndpointType {
  if (!baseURL) return "copilot";
  try {
    const hostname = new URL(baseURL).hostname.toLowerCase();
    if (hostname === GITHUB_COPILOT_HOSTNAME) {
      return "copilot";
    }
    if (hostname === "models.github.ai" || hostname.endsWith(".github.ai")) {
      return "models";
    }
    return "custom";
  } catch {
    return "copilot";
  }
}

export function normalizeGithubModelForEndpoint(
  requestedModel: string | undefined,
  endpointType: GithubEndpointType,
): string {
  const withoutQuery = requestedModel?.split("?", 1)[0]?.trim() ?? "";
  const localModel = providerLocalModelIdFromCatalog("github", withoutQuery);
  const resolvedModel =
    localModel || BUILT_IN_PROVIDER_DEFAULT_MODELS.github;

  if (endpointType !== "copilot") {
    return resolvedModel;
  }

  const slashIndex = resolvedModel.indexOf("/");
  return slashIndex === -1
    ? resolvedModel
    : resolvedModel.slice(slashIndex + 1);
}

export function shouldUseGithubCopilotResponsesApi(
  model: string | undefined,
  baseURL: string | undefined,
): boolean {
  const endpointType = getGithubEndpointType(baseURL);
  if (endpointType !== "copilot") return false;

  const normalized = normalizeGithubModelForEndpoint(model, endpointType)
    .toLowerCase();

  if (normalized.includes("providercode")) return true;

  const match = /^gpt-(\d+)(?:[.-]|$)/u.exec(normalized);
  if (!match || Number(match[1]) < 5) return false;
  return !/(?:^|[.-])mini(?:[.-]|$)/u.test(normalized);
}
