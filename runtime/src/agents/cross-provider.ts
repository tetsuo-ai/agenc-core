import type { Session } from "../session/session.js";
import type { AgenCConfig, AgentsConfig } from "../config/schema.js";
import { buildProviderModelCatalog } from "../config/provider-model-authority.js";
import { resolveBuiltInProviderSlug } from "../llm/registry/provider-info.js";
import { ModelRegistry, modelRegistryEntryToModelInfo } from "../llm/model-registry.js";
import type { ModelInfo } from "../session/turn-context.js";
import type { ProviderSelection } from "../session/provider-service.js";

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
  let qualified = false;
  if (model?.includes("/") &&
      !(requestedProvider === undefined && (catalog[active.provider] ?? []).includes(model))) {
    const slash = model.indexOf("/");
    const qualifiedProvider = resolveBuiltInProviderSlug(model.slice(0, slash));
    if (qualifiedProvider !== undefined) {
      qualified = true;
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
  if (provider !== active.provider || requestedProvider !== undefined || qualified) {
    assertCrossProviderAllowed(session, provider);
  }
  const inheritedLocalModel = requestedModel === undefined && provider === active.provider;
  const localModels = provider === active.provider && requestedModel !== undefined
    ? session.services.modelsManager?.tryListModels() ?? await session.services.modelsManager?.listModels()
    : undefined;
  const fixtureLocalModel = session.services.configStore === undefined &&
    provider === active.provider &&
    (localModels ?? []).some((candidate) => candidate.slug === model);
  if (!(catalog[provider] ?? []).includes(model) && !fixtureLocalModel && !inheritedLocalModel) {
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
        : await session.services.modelsManager.getModelInfo(selection.model);
  }
  const entry = await new ModelRegistry({ config: childCatalogConfig(session) }).resolve(selection);
  return modelRegistryEntryToModelInfo(entry);
}
