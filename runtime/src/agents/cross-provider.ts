import type { Session } from "../session/session.js";
import type { AgenCConfig, AgentsConfig } from "../config/schema.js";
import { buildProviderModelCatalog } from "../config/provider-model-authority.js";
import { resolveBuiltInProviderSlug } from "../llm/registry/provider-info.js";
import { ModelRegistry, modelRegistryEntryToModelInfo } from "../llm/model-registry.js";
import type { ModelInfo } from "../session/turn-context.js";
import type { PreparedProviderBinding, ProviderSelection } from "../session/provider-service.js";
import { resolveBuiltInProviderInfo } from "../llm/registry/provider-info.js";
import { assertSupportedCrossProviderAuth, type ChildAuthProfile, type ChildBillingSource } from "../llm/cross-provider-auth.js";
import { resolveRegisteredModelCatalogEntry } from "../llm/registry/model-catalog.js";
import type { ReasoningEffort } from "../session/turn-context.js";

export interface ChildExecutionPlan {
  readonly version: 1;
  /** The route can be agenc, while the destination is always concrete. */
  readonly route: ProviderSelection;
  readonly destination: ProviderSelection & {
    readonly endpoint: string;
    readonly authProfile: ChildAuthProfile;
    readonly billingSource: ChildBillingSource;
  };
  readonly modelInfo: ModelInfo;
  readonly catalogRevision: string;
  readonly requiredCapabilities: { readonly clientTools: boolean };
  readonly parent: { readonly sessionId: string; readonly agentPath: string };
  readonly task: { readonly id: string; readonly name: string };
  readonly scope: { readonly tools: "parent_filtered" | readonly string[]; readonly data: "task_only" | "forked_history"; readonly cwd: string };
  readonly policyRevision: string;
  readonly consentGrant: null; // Round B replaces this with a scoped grant.
  readonly budgetAllocation: null; // Budget accounting allocates this later.
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly crossProvider: boolean;
}

function fingerprint(value: unknown): string {
  const serialized = JSON.stringify(value);
  let hash = 2166136261;
  for (let i = 0; i < serialized.length; i++) {
    hash = Math.imul(hash ^ serialized.charCodeAt(i), 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function freezeValue<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) freezeValue(nested);
    Object.freeze(value);
  }
  return value;
}

function endpointIdentity(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href.replace(/\/+$/u, "");
  } catch {
    return "";
  }
}

function policyRevision(session: Session): string {
  const policy = childProviderPolicy(session);
  return `agents-v1:${fingerprint({ enabled: policy.cross_provider_enabled === true, allowed: policy.allowed_providers ?? [] })}`;
}

function catalogRevision(session: Session): string {
  return `catalog-v1:${fingerprint(buildProviderModelCatalog(childCatalogConfig(session), { includeConfiguredSelection: true }))}`;
}

export async function createChildExecutionPlan(params: {
  readonly session: Session;
  readonly selection: ProviderSelection;
  readonly modelInfo: ModelInfo;
  readonly parentPath: string;
  readonly taskId: string;
  readonly taskName: string;
  readonly toolFree: boolean;
  readonly forkedHistory: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly toolAllowlist?: readonly string[];
}): Promise<ChildExecutionPlan> {
  const { session, selection } = params;
  const crossProvider = selection.provider !== currentChildProvider(session).provider;
  if (crossProvider) assertCrossProviderAllowed(session, selection.provider);
  const destination = selection.provider === "agenc"
    ? await session.providerService.resolveManagedChildDestination(selection.model)
    : selection;
  if (selection.provider === "agenc") assertCrossProviderAllowed(session, destination.provider);
  if (selection.provider === "agenc" &&
      !(buildProviderModelCatalog(childCatalogConfig(session), { includeConfiguredSelection: true })[destination.provider] ?? [])
        .includes(destination.model)) {
    throw new Error(`Managed AgenC child resolved unknown destination ${destination.provider}/${destination.model}`);
  }
  const destinationModelInfo = selection.provider === "agenc"
    ? await childModelInfo(session, destination) : params.modelInfo;
  if (!params.toolFree && (destinationModelInfo.supportsToolUse === false ||
      resolveRegisteredModelCatalogEntry({ provider: destination.provider, model: destination.model })?.supportsToolUse === false)) {
    throw new Error(`Model ${destination.provider}/${destination.model} does not support client-side tool calling. Set tool_free = true for an explicitly tool-free task.`);
  }
  let endpoint = resolveBuiltInProviderInfo(destination.provider)?.baseURL ?? "";
  let authProfile: ChildAuthProfile = destination.provider === "ollama" || destination.provider === "lmstudio"
    ? "local" : selection.provider === "agenc" ? "managed" :
      destination.provider === "amazon-bedrock" ? "aws_sigv4" : "api_key";
  let billingSource: ChildBillingSource = authProfile === "local" ? "local" : authProfile === "managed" ? "managed" : "byok";
  if (crossProvider && typeof session.providerService?.prepareChild === "function") {
    const prepared = await session.providerService.prepareChild(selection, undefined, {}, true,
      selection.provider === "agenc" ? destination : undefined);
    try {
      endpoint = selection.provider === "agenc"
        ? endpoint
        : prepared.binding.factoryOptions?.baseURL ?? endpoint;
      authProfile = prepared.authProfile ?? authProfile;
      billingSource = prepared.billingSource ?? billingSource;
    } finally {
      await prepared.binding.instance.dispose?.();
    }
  } else if (!crossProvider) {
    endpoint = session.providerService?.current().factoryOptions?.baseURL ?? endpoint;
  }
  if (crossProvider) assertSupportedCrossProviderAuth(destination.provider, authProfile);
  return Object.freeze({
    version: 1 as const,
    route: Object.freeze({ ...selection }),
    destination: Object.freeze({ ...destination, endpoint: endpointIdentity(endpoint), authProfile, billingSource }),
    modelInfo: freezeValue(structuredClone(destinationModelInfo)),
    catalogRevision: catalogRevision(session),
    requiredCapabilities: Object.freeze({ clientTools: !params.toolFree }),
    parent: Object.freeze({ sessionId: session.conversationId, agentPath: params.parentPath }),
    task: Object.freeze({ id: params.taskId, name: params.taskName }),
    scope: Object.freeze({ tools: params.toolFree ? Object.freeze([]) :
      Array.isArray(session.services.registry?.tools)
        ? Object.freeze(session.services.registry.tools
            .map((tool) => tool.name)
            .filter((name) => params.toolAllowlist === undefined || params.toolAllowlist.includes(name)))
        : "parent_filtered" as const,
      data: params.forkedHistory ? "forked_history" as const : "task_only" as const,
      cwd: session.sessionConfiguration.cwd }),
    policyRevision: policyRevision(session),
    consentGrant: null,
    budgetAllocation: null,
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
    crossProvider,
  });
}

export async function assertChildExecutionPlan(session: Session, plan: ChildExecutionPlan): Promise<void> {
  if (plan.parent.sessionId !== session.conversationId) throw new Error("child execution plan parent changed");
  if (plan.policyRevision !== policyRevision(session)) throw new Error("child execution plan policy changed");
  if (plan.catalogRevision !== catalogRevision(session)) throw new Error("child execution plan catalog changed");
  const selected = !plan.crossProvider &&
      resolveBuiltInProviderSlug(plan.route.provider) === undefined
    ? { provider: currentChildProvider(session).provider, model: plan.route.model }
    : await resolveChildSelection(session, plan.route.provider, plan.route.model);
  if (selected.provider !== plan.route.provider || selected.model !== plan.route.model) {
    throw new Error("child execution plan route changed");
  }
  if (plan.route.provider === "agenc") {
    assertCrossProviderAllowed(session, plan.destination.provider);
    if (!(buildProviderModelCatalog(childCatalogConfig(session), { includeConfiguredSelection: true })[plan.destination.provider] ?? [])
        .includes(plan.destination.model)) {
      throw new Error("managed child destination is no longer in the catalog");
    }
    const destination = await session.providerService.resolveManagedChildDestination(plan.route.model);
    if (destination.provider !== plan.destination.provider || destination.model !== plan.destination.model) {
      throw new Error("managed child destination changed from execution plan");
    }
  } else if (plan.destination.provider !== plan.route.provider || plan.destination.model !== plan.route.model) {
    throw new Error("child execution plan destination changed");
  }
  if (plan.modelInfo.slug !== plan.destination.model ||
      (plan.modelInfo.provider !== undefined && plan.modelInfo.provider !== plan.destination.provider)) {
    throw new Error("child execution plan model metadata differs from destination");
  }
  if (!plan.requiredCapabilities.clientTools &&
      (plan.scope.tools === "parent_filtered" || plan.scope.tools.length > 0)) {
    throw new Error("child execution plan tool scope conflicts with required capabilities");
  }
  const catalogEntry = resolveRegisteredModelCatalogEntry({
    provider: plan.destination.provider, model: plan.destination.model,
  });
  if (plan.requiredCapabilities.clientTools && plan.modelInfo.supportsToolUse === false) {
    throw new Error(`Model ${plan.destination.provider}/${plan.destination.model} cannot call client-side tools`);
  }
  if (plan.requiredCapabilities.clientTools && catalogEntry?.supportsToolUse === false) {
    throw new Error(`Model ${plan.destination.provider}/${plan.destination.model} cannot call client-side tools`);
  }
}

export function assertPreparedChildMatchesPlan(plan: ChildExecutionPlan, prepared: PreparedProviderBinding): void {
  if (prepared.binding.provider !== plan.route.provider ||
      prepared.binding.model !== plan.route.model ||
      (prepared.authProfile !== undefined && prepared.authProfile !== plan.destination.authProfile) ||
      (prepared.billingSource !== undefined && prepared.billingSource !== plan.destination.billingSource)) {
    throw new Error("prepared child destination or authority differs from execution plan");
  }
  if (plan.route.provider !== "agenc") {
    const canonical = resolveBuiltInProviderInfo(plan.route.provider)?.baseURL;
    const endpoint = prepared.binding.factoryOptions?.baseURL ?? canonical;
    const normalize = (value: string | undefined): string | undefined => {
      if (value === undefined) return undefined;
      try { return new URL(value).href.replace(/\/+$/u, ""); }
      catch { return value.trim(); }
    };
    if (normalize(endpoint) !== normalize(plan.destination.endpoint)) {
      throw new Error("prepared child endpoint differs from execution plan");
    }
  }
}

export function childProviderPolicy(session: Session): AgentsConfig {
  return session.services.configStore?.current().agents ?? session.config?.agents ?? {};
}

export function childCatalogConfig(session: Session): AgenCConfig {
  return session.services.configStore?.current() ?? {
    model: session.modelInfo.slug,
    model_provider: currentChildProvider(session).provider,
  };
}

export function currentChildProvider(session: Session): ProviderSelection {
  // Sessions constructed by normal ingress always have providerService. The
  // fallback exists only for legacy/test Session stubs without that service.
  return session.providerService?.current() ?? {
    provider: session.services.configStore?.current().model_provider ?? "grok",
    model: session.modelInfo.slug,
  };
}

export function assertCrossProviderAllowed(session: Session, provider: string): void {
  const policy = childProviderPolicy(session);
  if (policy.cross_provider_enabled !== true) {
    throw new Error("Cross-provider subagents are off. Set [agents] cross_provider_enabled = true in user config.toml.");
  }
  if (!(policy.allowed_providers ?? []).includes(provider)) {
    throw new Error(`Provider \`${provider}\` is not allowed for subagents. Add it to [agents] allowed_providers in user config.toml.`);
  }
}

export function allowedChildPairs(session: Session): readonly ProviderSelection[] {
  // TODO(phase 3): rank these permitted pairs with maintained task_kind metadata.
  const policy = childProviderPolicy(session);
  if (policy.cross_provider_enabled !== true) return [];
  const catalog = buildProviderModelCatalog(childCatalogConfig(session), { includeConfiguredSelection: true });
  return (policy.allowed_providers ?? []).flatMap((provider) =>
    (catalog[provider] ?? []).map((model) => ({ provider, model })),
  );
}

export async function resolveChildSelection(
  session: Session,
  requestedProvider: string | undefined,
  requestedModel: string | undefined,
): Promise<ProviderSelection> {
  const active = currentChildProvider(session);
  let provider: string | undefined = requestedProvider === undefined
    ? undefined
    : resolveBuiltInProviderSlug(requestedProvider);
  if (requestedProvider !== undefined && provider === undefined) {
    throw new Error(`Unknown provider \`${requestedProvider}\` for spawn_agent. Use a built-in provider name.`);
  }
  let model = requestedModel?.trim();
  const catalog = buildProviderModelCatalog(childCatalogConfig(session), { includeConfiguredSelection: true });
  const localModels = requestedModel === undefined ||
      (provider !== undefined && provider !== active.provider)
    ? undefined
    : session.services.modelsManager?.tryListModels() ?? await session.services.modelsManager?.listModels();
  const isLiveLocalModel = (slug: string): boolean =>
    (localModels ?? []).some((candidate) =>
      candidate.slug === slug &&
      (candidate.provider === undefined || candidate.provider === active.provider));
  if (model?.includes("/") && !(
    provider === active.provider
      ? isLiveLocalModel(model)
      : provider !== undefined
        ? (catalog[provider] ?? []).includes(model)
        : isLiveLocalModel(model)
  )) {
    const slash = model.indexOf("/");
    const qualifiedProvider = resolveBuiltInProviderSlug(model.slice(0, slash));
    if (qualifiedProvider !== undefined) {
      if (provider !== undefined && provider !== qualifiedProvider) {
        throw new Error(`Provider \`${provider}\` conflicts with qualified model \`${model}\`. Use the same provider in both fields.`);
      }
      provider = qualifiedProvider;
      model = model.slice(slash + 1);
    }
  }
  provider ??= active.provider;
  model ??= session.sessionConfiguration.collaborationMode.model ?? active.model;
  if (!model) throw new Error("spawn_agent requires a model for the selected provider.");
  if (provider !== active.provider) {
    assertCrossProviderAllowed(session, provider);
  }
  const inheritedLocalModel = requestedModel === undefined && provider === active.provider;
  const knownModel = provider === active.provider
    ? isLiveLocalModel(model) || inheritedLocalModel
    : (catalog[provider] ?? []).includes(model);
  if (!knownModel) {
    const alternatives = Object.entries(catalog)
      .filter(([, models]) => models.includes(model))
      .map(([name]) => name);
    if (requestedProvider === undefined && alternatives.length > 0) {
      throw new Error(`Model \`${model}\` is not a model of \`${provider}\`. Specify provider and model together, for example \`${alternatives[0]}/${model}\`.`);
    }
    throw new Error(`Unknown model or provider/model pair \`${provider}/${model}\` for spawn_agent. Choose a pair listed in the tool description.`);
  }
  return { provider, model };
}

export async function childModelInfo(
  session: Session,
  selection: ProviderSelection,
): Promise<ModelInfo> {
  if (selection.provider === currentChildProvider(session).provider) {
    return selection.model === session.modelInfo.slug
      ? session.modelInfo
      : session.services.modelsManager === undefined
        ? { ...session.modelInfo, slug: selection.model }
        : await (session.services.modelsManager.getModelInfoForProvider?.(selection.provider, selection.model) ??
            session.services.modelsManager.getModelInfo(selection.model));
  }
  const manager = session.services.modelsManager;
  if (manager?.getModelInfoForProvider !== undefined) {
    return await manager.getModelInfoForProvider(selection.provider, selection.model);
  }
  const entry = await new ModelRegistry({
    config: childCatalogConfig(session),
    metadata: { env: session.providerService?.environment?.() ?? session.services.providerEnvironment ?? {} },
  }).resolve(selection);
  return modelRegistryEntryToModelInfo(entry);
}
