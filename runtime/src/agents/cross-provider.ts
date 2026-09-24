import type { Session } from "../session/session.js";
import { createHash } from "node:crypto";
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
import { DEFAULT_MODEL_COSTS, resolveModelCostEntry } from "../session/cost.js";

export interface CrossProviderConsentGrant {
  readonly kind: "once" | "session";
  readonly ownerSessionId: string;
  /** Changes when the root interactive session ends, including across restart. */
  readonly sessionEpoch: string;
  readonly taskId: string;
  readonly scopeKey: string;
  readonly payloadKey: string;
}

export interface CrossProviderSpawnDisclosure {
  readonly kind: "cross_provider_spawn";
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly billingSource: ChildBillingSource;
  readonly taskId: string;
  readonly taskText: string;
  readonly attachments: readonly string[];
  readonly workspace: string;
  readonly sandboxMode: string;
  readonly fileReadAllowlist: readonly string[];
  readonly fileReadDenylist: readonly string[];
  readonly dataScope: "task_only" | "forked_history";
  readonly tools: "parent_filtered" | readonly string[];
  readonly network: boolean;
  readonly search: boolean;
  readonly price: { readonly inputUsdPer1K: number; readonly outputUsdPer1K: number } | "price unknown";
  readonly subscriptionUsageNote?: string;
  readonly maxModelCalls: number | null;
  readonly futureToolResultsGoToProvider: true;
  readonly scopeKey: string;
  readonly payloadKey: string;
  /** Turn captured when this disclosure was made. */
  readonly requestingTurnId: string;
  /** Equivalent re-asks within the same parent turn use this key. */
  readonly denialKey: string;
}

export type CrossProviderConsentOutcome =
  | { readonly kind: "granted"; readonly grant: CrossProviderConsentGrant }
  | { readonly kind: "consent_denied" | "consent_unavailable"; readonly reason: string };

export interface CrossProviderConsentService {
  readonly ownerSessionId: string;
  readonly sessionEpoch: string;
  request(session: Session, disclosure: CrossProviderSpawnDisclosure,
    options?: { readonly fresh?: boolean }): Promise<CrossProviderConsentOutcome>;
}

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
  readonly task: { readonly id: string; readonly name: string; readonly text: string; readonly attachments: readonly string[]; readonly parentTurnId?: string };
  readonly scope: { readonly tools: "parent_filtered" | readonly string[]; readonly data: "task_only" | "forked_history"; readonly cwd: string;
    readonly sandboxMode?: string; readonly fileReadAllowlist?: readonly string[];
    readonly fileReadDenylist?: readonly string[]; readonly networkEnabled?: boolean };
  readonly policyRevision: string;
  readonly consentGrant: CrossProviderConsentGrant | null;
  readonly budgetAllocation: { readonly maxModelCalls: number } | null;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly crossProvider: boolean;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
  readonly taskText: string;
  readonly attachments?: readonly string[];
  readonly toolFree: boolean;
  readonly forkedHistory: boolean;
  readonly reasoningEffort?: ReasoningEffort;
  readonly serviceTier?: string;
  readonly toolAllowlist?: readonly string[];
  /** Destination provenance inherited through a same-provider child. */
  readonly inheritedConsentPlan?: ChildExecutionPlan;
}, preliminaryManaged = false): Promise<ChildExecutionPlan> {
  const { session, selection } = params;
  const crossProvider = selection.provider !== currentChildProvider(session).provider ||
    params.inheritedConsentPlan?.crossProvider === true;
  if (crossProvider) assertCrossProviderAllowed(session, selection.provider);
  if (crossProvider && selection.provider === "agenc" && !preliminaryManaged) {
    // Concrete managed routing may contact the authenticated AgenC backend.
    // First disclose the locally known managed route, then request separate
    // consent for the concrete provider/model after routing is resolved.
    const preliminary = await createChildExecutionPlan(params, true);
    const consent = await authorizeChildExecutionPlan(session, preliminary);
    if (consent.kind !== "granted") throw new Error(`${consent.kind}: ${consent.reason}`);
  }
  const destination = selection.provider === "agenc"
    ? preliminaryManaged ? selection
      : await session.providerService.resolveManagedChildDestination(selection.model)
    : selection;
  if (crossProvider && selection.provider === "agenc") assertCrossProviderAllowed(session, destination.provider);
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
  if (crossProvider && typeof session.providerService?.previewChildDestination === "function") {
    // Disclose from local configuration; authenticated discovery follows consent.
    const preview = await session.providerService.previewChildDestination(selection,
      selection.provider === "agenc" ? destination : undefined);
    endpoint = preview.endpoint;
    authProfile = preview.authProfile;
    billingSource = preview.billingSource;
  } else if (!crossProvider) {
    endpoint = session.providerService?.current().factoryOptions?.baseURL ?? endpoint;
  }
  if (crossProvider) assertSupportedCrossProviderAuth(destination.provider, authProfile);
  return Object.freeze({
    version: 1 as const,
    route: Object.freeze({ ...selection }),
    destination: Object.freeze({ ...destination, endpoint: endpointIdentity(endpoint), authProfile, billingSource }),
    modelInfo: freezeValue({ ...structuredClone(destinationModelInfo) }),
    catalogRevision: catalogRevision(session),
    requiredCapabilities: Object.freeze({ clientTools: !params.toolFree }),
    parent: Object.freeze({ sessionId: session.conversationId, agentPath: params.parentPath }),
    task: Object.freeze({ id: params.taskId, name: params.taskName, text: params.taskText,
      attachments: Object.freeze([...(params.attachments ?? [])]),
      ...(session.activeTurn?.unsafePeek()?.turnId !== undefined
        ? { parentTurnId: session.activeTurn.unsafePeek()!.turnId } : {}) }),
    scope: Object.freeze({ tools: params.toolFree ? Object.freeze([]) :
      Array.isArray(session.services.registry?.tools)
        ? Object.freeze(session.services.registry.tools
            .map((tool) => tool.name)
            .filter((name) => params.toolAllowlist === undefined || params.toolAllowlist.includes(name)))
        : "parent_filtered" as const,
      data: params.forkedHistory ? "forked_history" as const : "task_only" as const,
      cwd: session.sessionConfiguration.cwd,
      sandboxMode: session.sessionConfiguration.sandboxPolicy?.value ?? "unknown",
      fileReadAllowlist: Object.freeze([...(session.sessionConfiguration.fileSystemSandboxPolicy?.allowRead ?? [])]),
      fileReadDenylist: Object.freeze([...(session.sessionConfiguration.fileSystemSandboxPolicy?.denyRead ?? [])]),
      networkEnabled: session.sessionConfiguration.networkSandboxPolicy?.enabled !== false }),
    policyRevision: policyRevision(session),
    consentGrant: null,
    budgetAllocation: crossProvider ? Object.freeze({
      maxModelCalls: Math.min(32, Math.max(1, session.config?.maxTurns ?? 32)),
    }) : null,
    ...(params.reasoningEffort !== undefined ? { reasoningEffort: params.reasoningEffort } : {}),
    ...(params.serviceTier !== undefined ? { serviceTier: params.serviceTier } : {}),
    crossProvider,
  });
}

export function buildCrossProviderDisclosure(
  plan: ChildExecutionPlan,
  taskText: string = plan.task.text,
  attachments: readonly string[] = plan.task.attachments,
): CrossProviderSpawnDisclosure {
  const tools = plan.scope.tools;
  const search = resolveRegisteredModelCatalogEntry({ provider: plan.destination.provider,
    model: plan.destination.model })?.supportsSearchTool === true ||
    tools === "parent_filtered" || tools.some((tool) => /search|browse/iu.test(tool));
  const network = plan.scope.networkEnabled !== false && (search ||
    tools.some((tool) => /web|fetch|network|http|exec|shell/iu.test(tool)));
  const scopeKey = fingerprint({ destination: plan.destination, data: plan.scope.data,
    cwd: plan.scope.cwd, tools, network, search, sandboxMode: plan.scope.sandboxMode,
    fileReadAllowlist: plan.scope.fileReadAllowlist, fileReadDenylist: plan.scope.fileReadDenylist,
    attachments, budget: plan.budgetAllocation });
  const payloadKey = fingerprint({ scopeKey, taskId: plan.task.id, taskText, attachments });
  const parentTurnId = sessionTurnIdForPlan(plan);
  const denialKey = crossProviderDenialKey({ scopeKey, taskText, attachments }, parentTurnId);
  const cost = resolveModelCostEntry({ provider: plan.destination.provider, model: plan.destination.model }, DEFAULT_MODEL_COSTS);
  return Object.freeze({
    kind: "cross_provider_spawn" as const,
    provider: plan.destination.provider, model: plan.destination.model,
    endpoint: plan.destination.endpoint, billingSource: plan.destination.billingSource,
    taskId: plan.task.id, taskText, attachments: Object.freeze([...attachments]),
    workspace: plan.scope.cwd, sandboxMode: plan.scope.sandboxMode ?? "unknown",
    fileReadAllowlist: plan.scope.fileReadAllowlist ?? [],
    fileReadDenylist: plan.scope.fileReadDenylist ?? [],
    dataScope: plan.scope.data, tools,
    network, search,
    price: plan.destination.billingSource === "sign_in" || cost === null ? "price unknown" as const : {
      inputUsdPer1K: cost.entry.inputUsdPer1K, outputUsdPer1K: cost.entry.outputUsdPer1K,
    },
    ...(plan.destination.billingSource === "sign_in" ? {
      subscriptionUsageNote: "Usage counts against your subscription limits.",
    } : {}),
    maxModelCalls: plan.budgetAllocation?.maxModelCalls ?? null,
    futureToolResultsGoToProvider: true as const, scopeKey, payloadKey,
    requestingTurnId: parentTurnId, denialKey,
  });
}

export function crossProviderDenialKey(
  disclosure: Pick<CrossProviderSpawnDisclosure, "scopeKey" | "taskText" | "attachments">,
  turnId: string,
): string {
  return fingerprint({ scopeKey: disclosure.scopeKey, parentTurnId: turnId,
    taskText: disclosure.taskText, attachments: disclosure.attachments });
}

function sessionTurnIdForPlan(plan: ChildExecutionPlan): string {
  return plan.task.parentTurnId ?? plan.parent.sessionId;
}

export function withChildConsentGrant(plan: ChildExecutionPlan, grant: CrossProviderConsentGrant): ChildExecutionPlan {
  return Object.freeze({ ...plan, consentGrant: Object.freeze({ ...grant }) });
}

export function consentGrantCoversPlan(
  plan: ChildExecutionPlan,
  ownerSessionId: string,
  taskText: string = plan.task.text,
  attachments: readonly string[] = plan.task.attachments,
  sessionEpoch?: string,
): boolean {
  if (!plan.crossProvider) return true;
  const grant = plan.consentGrant;
  if (grant === null || grant === undefined || grant.ownerSessionId !== ownerSessionId ||
      (sessionEpoch !== undefined && grant.sessionEpoch !== sessionEpoch) ||
      grant.taskId !== plan.task.id) return false;
  const disclosure = buildCrossProviderDisclosure(plan, taskText, attachments);
  return grant.scopeKey === disclosure.scopeKey &&
    (grant.kind === "session" || grant.payloadKey === disclosure.payloadKey);
}

/** The only path that turns a proposed cross-provider plan into a dispatchable one. */
export async function authorizeChildExecutionPlan(session: Session, plan: ChildExecutionPlan,
  options: { readonly fresh?: boolean } = {}): Promise<
  { readonly kind: "granted"; readonly plan: ChildExecutionPlan } |
  { readonly kind: "consent_denied" | "consent_unavailable"; readonly reason: string }
> {
  if (!plan.crossProvider) return { kind: "granted", plan };
  const service = (session.services as { readonly crossProviderConsent?: CrossProviderConsentService }).crossProviderConsent;
  if (service === undefined) return { kind: "consent_unavailable", reason: "No attached client can answer cross-provider consent. Continue this task yourself." };
  const outcome = await service.request(session, buildCrossProviderDisclosure(plan), options);
  if (outcome.kind !== "granted") return outcome;
  const granted = withChildConsentGrant(plan, outcome.grant);
  if (!consentGrantCoversPlan(granted, service.ownerSessionId, plan.task.text,
      plan.task.attachments, service.sessionEpoch)) {
    return { kind: "consent_unavailable", reason: "Consent grant did not cover this exact child task. Continue this task yourself." };
  }
  return { kind: "granted", plan: granted };
}

export async function assertChildExecutionPlan(session: Session, plan: ChildExecutionPlan): Promise<void> {
  if (plan.crossProvider) {
    if (plan.budgetAllocation === null || !Number.isSafeInteger(plan.budgetAllocation.maxModelCalls) ||
        plan.budgetAllocation.maxModelCalls < 1 || plan.budgetAllocation.maxModelCalls > 32) {
      throw new Error("resume_blocked: cross-provider plan has no bounded model-call allocation");
    }
    const service = (session.services as { readonly crossProviderConsent?: CrossProviderConsentService }).crossProviderConsent;
    if (service === undefined || !consentGrantCoversPlan(plan, service.ownerSessionId,
        plan.task.text, plan.task.attachments, service.sessionEpoch)) {
      throw new Error("resume_blocked: cross-provider child has no live, in-scope human consent grant");
    }
  }
  if (plan.parent.sessionId !== session.conversationId) throw new Error("child execution plan parent changed");
  if (plan.policyRevision !== policyRevision(session)) throw new Error("child execution plan policy changed");
  // A plan pins one destination. Other providers can gain models without
  // changing that approval; selection and prepared binding checks below
  // validate the destination and the capabilities this child uses.
  const selected = !plan.crossProvider &&
      resolveBuiltInProviderSlug(plan.route.provider) === undefined
    ? { provider: currentChildProvider(session).provider, model: plan.route.model }
    : await resolveChildSelection(session, plan.route.provider, plan.route.model,
      plan.crossProvider ? plan.destination : undefined);
  if (selected.provider !== plan.route.provider || selected.model !== plan.route.model) {
    throw new Error("child execution plan route changed");
  }
  if (plan.route.provider === "agenc") {
    if (plan.crossProvider) assertCrossProviderAllowed(session, plan.destination.provider);
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
  if (plan.destination.authProfile === "sign_in" && prepared.authProfile !== "sign_in") {
    throw new Error("resume_blocked: child sign-in authority is no longer available");
  }
  if (plan.requiredCapabilities.clientTools &&
      prepared.signInModelCapabilities?.supportsToolUse === false) {
    throw new Error("resume_blocked: sign-in model no longer supports child tools");
  }
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
  if (session.services == null) return {};
  return session.services?.configStore?.current().agents ?? session.config?.agents ?? {};
}

export function childCatalogConfig(session: Session): AgenCConfig {
  return session.services?.configStore?.current() ?? {
    model: session.modelInfo.slug,
    model_provider: currentChildProvider(session).provider,
  };
}

export function currentChildProvider(session: Session): ProviderSelection {
  // Sessions constructed by normal ingress always have providerService. The
  // fallback exists only for legacy/test Session stubs without that service.
  return session.providerService?.current() ?? {
    provider: session.services?.configStore?.current().model_provider ?? "grok",
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
  approvedDestination?: ChildExecutionPlan["destination"],
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
  let knownModel = provider === active.provider
    ? isLiveLocalModel(model) || inheritedLocalModel
    : (catalog[provider] ?? []).includes(model);
  // Account-specific sign-in models are admitted provisionally. Their live
  // /models eligibility is checked through the pinned transport after consent.
  const approvedSignInChild = approvedDestination?.authProfile === "sign_in" &&
    approvedDestination.provider === provider && approvedDestination.model === model;
  if (!knownModel && (provider !== active.provider || approvedSignInChild) &&
      (provider === "openai" || provider === "grok") &&
      typeof session.providerService?.previewChildDestination === "function") {
    knownModel = (await session.providerService.previewChildDestination({ provider, model })).authProfile === "sign_in";
  }
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
  localOnly = false,
): Promise<ModelInfo> {
  if (!localOnly && selection.provider === currentChildProvider(session).provider) {
    if (selection.model === session.modelInfo.slug) return session.modelInfo;
    if (session.services.modelsManager !== undefined) {
      return await (session.services.modelsManager.getModelInfoForProvider?.(selection.provider, selection.model) ??
        session.services.modelsManager.getModelInfo(selection.model));
    }
    const { modelMessages: _parentMessages, ...parentInfo } = session.modelInfo;
    return { ...parentInfo, slug: selection.model, supportsPersonality: false };
  }
  const entry = new ModelRegistry({
    config: childCatalogConfig(session),
    metadata: { env: session.providerService?.environment?.() ?? session.services.providerEnvironment ?? {} },
  }).resolveSync(selection);
  return modelRegistryEntryToModelInfo(entry);
}
