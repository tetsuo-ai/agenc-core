import { normalizeGrokModel } from "./context-window.js";

export interface ModelRouteSnapshot {
  readonly provider: string;
  readonly model: string;
  readonly configuredModel?: string;
  readonly resolvedModel?: string;
  readonly usedFallback: boolean;
  readonly source?: string;
  readonly updatedAt: number;
}

function normalizeText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function canonicalizeProviderModel(
  provider: unknown,
  model: unknown,
): string | undefined {
  const normalizedModel = normalizeText(model);
  if (!normalizedModel) {
    return undefined;
  }
  const normalizedProvider = normalizeText(provider)?.toLowerCase();
  if (normalizedProvider === "grok") {
    return normalizeGrokModel(normalizedModel) ?? normalizedModel;
  }
  return normalizedModel;
}

export function normalizeModelRouteSnapshot(
  input: {
    readonly provider?: unknown;
    readonly llmProvider?: unknown;
    readonly model?: unknown;
    readonly llmModel?: unknown;
    readonly configuredModel?: unknown;
    readonly resolvedModel?: unknown;
    readonly usedFallback?: unknown;
    readonly source?: unknown;
    readonly updatedAt?: unknown;
  } = {},
  nowMs: () => number = Date.now,
): ModelRouteSnapshot | null {
  const provider =
    normalizeText(input.provider) ??
    normalizeText(input.llmProvider) ??
    "unknown";
  const configuredModel =
    normalizeText(input.configuredModel) ??
    normalizeText(input.model) ??
    normalizeText(input.llmModel);
  const resolvedModel =
    canonicalizeProviderModel(
      provider,
      input.resolvedModel ??
        input.model ??
        input.llmModel ??
        input.configuredModel,
    );
  if (!configuredModel && !resolvedModel) {
    return null;
  }
  const source = normalizeText(input.source);
  const updatedAt =
    typeof input.updatedAt === "number" && Number.isFinite(input.updatedAt)
      ? input.updatedAt
      : nowMs();
  const model = resolvedModel ?? configuredModel ?? "unknown";
  return {
    provider,
    model,
    ...(configuredModel ? { configuredModel } : {}),
    ...(resolvedModel ? { resolvedModel } : {}),
    usedFallback: input.usedFallback === true,
    ...(source ? { source } : {}),
    updatedAt,
  };
}

export function formatModelRouteModelLabel(
  route: Pick<ModelRouteSnapshot, "model" | "configuredModel" | "resolvedModel"> | null | undefined,
): string {
  if (!route) {
    return "unknown";
  }
  const configuredModel = normalizeText(route.configuredModel);
  const resolvedModel = normalizeText(route.resolvedModel) ?? normalizeText(route.model);
  if (
    configuredModel &&
    resolvedModel &&
    configuredModel !== resolvedModel
  ) {
    return `${configuredModel} (${resolvedModel})`;
  }
  return resolvedModel ?? configuredModel ?? "unknown";
}

export function modelRouteSnapshotsMatch(
  left: Pick<ModelRouteSnapshot, "provider" | "configuredModel" | "resolvedModel" | "model"> | null | undefined,
  right: Pick<ModelRouteSnapshot, "provider" | "configuredModel" | "resolvedModel" | "model"> | null | undefined,
): boolean {
  const leftProvider = normalizeText(left?.provider);
  const rightProvider = normalizeText(right?.provider);
  const leftResolved =
    canonicalizeProviderModel(leftProvider, left?.resolvedModel ?? left?.model) ??
    normalizeText(left?.configuredModel);
  const rightResolved =
    canonicalizeProviderModel(rightProvider, right?.resolvedModel ?? right?.model) ??
    normalizeText(right?.configuredModel);
  return Boolean(
    leftProvider &&
      rightProvider &&
      leftResolved &&
      rightResolved &&
      leftProvider === rightProvider &&
      leftResolved === rightResolved,
  );
}
