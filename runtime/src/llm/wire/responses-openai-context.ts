/**
 * OpenAI's platform Responses API can load tools and change effort at a
 * conversation boundary without rewriting its original cached prefix.
 * Events live on the assistant response they produced, so stateless CLI
 * continuations replay them in the same positions after a daemon restart.
 * https://developers.openai.com/api/docs/guides/tools-tool-search
 * https://developers.openai.com/api/docs/guides/reasoning
 */
import { createHash } from "node:crypto";
import type { LLMChatOptions, LLMMessage, ProviderContextHistory } from "../types.js";

type Item = Record<string, unknown>;
type Effort = NonNullable<LLMChatOptions["reasoningEffort"]>;
const EFFORTS = new Set<string>(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const normalizeModel = (model: string): string => model.trim().toLowerCase().replace(/^openai[/:]/u, "");

/** Only documented standard models and dated snapshots, never pro or lookalikes. */
export function supportsOpenAIConfigurationUpdates(model: string): boolean {
  return /^gpt-6(?:\.\d+)?-(?:astra|sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?$/u.test(normalizeModel(model));
}

/** Tool search and additional_tools are documented for GPT-5.4 and later. */
export function supportsOpenAIAdditionalTools(model: string): boolean {
  return supportsOpenAIConfigurationUpdates(model) ||
    /^gpt-5\.(?:4|5|6)(?:-(?:mini|nano|pro|sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/u.test(normalizeModel(model));
}

function onlyKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).every(key => keys.includes(key));
}

function toolList(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every(tool => tool !== null && typeof tool === "object" &&
    onlyKeys(tool, ["type", "name", "description", "parameters", "strict"]) &&
    (tool.strict === undefined || typeof tool.strict === "boolean") &&
    tool.type === "function" && typeof tool.name === "string" && typeof tool.description === "string" &&
    tool.parameters !== null && typeof tool.parameters === "object" && !Array.isArray(tool.parameters));
}

/** Durable data is validated before being used as provider configuration. */
export function readProviderContextHistory(value: unknown): ProviderContextHistory | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const event = value as ProviderContextHistory;
  if (!onlyKeys(event, ["version", "provider", "model", "initial", "tools", "reasoningEffort", "beforeUser"]) ||
      event.version !== 1 || event.provider !== "openai" || typeof event.model !== "string" ||
      (event.initial !== undefined && (!event.initial ||
        !onlyKeys(event.initial, ["tools", "reasoningEffort"]) || !toolList(event.initial.tools) ||
        (event.initial.reasoningEffort !== undefined && !EFFORTS.has(event.initial.reasoningEffort)))) ||
      (event.tools !== undefined && !toolList(event.tools)) ||
      (event.reasoningEffort !== undefined && !EFFORTS.has(event.reasoningEffort)) ||
      (event.beforeUser !== undefined && (typeof event.beforeUser !== "string" || !/^[a-f0-9]{64}$/u.test(event.beforeUser)))) return undefined;
  return event;
}

function userKey(message: LLMMessage): string {
  return createHash("sha256").update(JSON.stringify(message.content)).digest("hex");
}

export interface OpenAIContextPlan {
  readonly tools: readonly Item[];
  readonly reasoningEffort: LLMChatOptions["reasoningEffort"];
  readonly before: ReadonlyMap<number, readonly Item[]>;
  readonly event?: ProviderContextHistory;
}

export function planOpenAIContext(input: {
  readonly enabled?: boolean;
  readonly model: string;
  readonly messages: readonly LLMMessage[];
  readonly tools: readonly Item[];
  readonly reasoningEffort: LLMChatOptions["reasoningEffort"];
}): OpenAIContextPlan {
  const { model, messages, tools, reasoningEffort } = input;
  if (!input.enabled || !supportsOpenAIAdditionalTools(model)) {
    return { tools, reasoningEffort, before: new Map() };
  }
  const updatesEffort = supportsOpenAIConfigurationUpdates(model);
  const start = (): OpenAIContextPlan => ({ tools, reasoningEffort, before: new Map(), event: {
    version: 1, provider: "openai", model,
    initial: { tools: structuredClone(tools), ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) },
  } });
  let initial: NonNullable<ProviderContextHistory["initial"]> | undefined;
  let effectiveEffort: LLMChatOptions["reasoningEffort"];
  const available = new Map<string, Item>();
  const before = new Map<number, Item[]>();
  const add = (at: number, item: Item): void => { before.set(at, [...(before.get(at) ?? []), item]); };
  let latestUser = -1;
  let lastAssistant = -1;
  for (const [index, message] of messages.entries()) {
    if (message.role === "user") latestUser = index;
    if (message.role !== "assistant") continue;
    const event = readProviderContextHistory(message.providerContextHistory);
    if (!event || normalizeModel(event.model) !== normalizeModel(model)) {
      lastAssistant = index;
      continue;
    }
    if (event.initial !== undefined) {
      initial = event.initial;
      effectiveEffort = initial.reasoningEffort;
      before.clear();
      available.clear();
      for (const tool of initial.tools) available.set(String(tool.name), tool);
    }
    if (initial === undefined) continue;
    if (event.tools?.length) {
      for (const tool of event.tools) {
        // Replacing a definition requires a new prefix, not duplicate names.
        if (available.has(String(tool.name))) return start();
        available.set(String(tool.name), tool);
      }
      add(index, { type: "additional_tools", role: "developer", tools: structuredClone(event.tools) });
    }
    if (updatesEffort && event.reasoningEffort !== undefined) {
      const at = event.beforeUser === undefined ? index : latestUser;
      if (at < 0 || (event.beforeUser !== undefined && userKey(messages[at]!) !== event.beforeUser)) return start();
      add(at, { type: "configuration_update", reasoning: { effort: event.reasoningEffort } });
      effectiveEffort = event.reasoningEffort;
    }
    lastAssistant = index;
  }
  if (initial === undefined) return start();
  // Revoked tools or changed schemas/descriptions must stop being available.
  // Abandon the old prefix rather than reintroduce a revoked definition.
  const current = new Map(tools.map(tool => [String(tool.name), tool]));
  for (const [name, tool] of available) {
    if (JSON.stringify(current.get(name)) !== JSON.stringify(tool)) return start();
  }
  const added = tools.filter(tool => !available.has(String(tool.name)));
  const event: ProviderContextHistory = { version: 1, provider: "openai", model,
    ...(added.length ? { tools: structuredClone(added) } : {}),
    ...(updatesEffort && (effectiveEffort ?? "medium") !== (reasoningEffort ?? "medium")
      ? { reasoningEffort: (reasoningEffort ?? "medium") as Effort,
          ...(latestUser > lastAssistant ? { beforeUser: userKey(messages[latestUser]!) } : {}) }
      : {}),
  };
  if (event.reasoningEffort !== undefined) {
    add(event.beforeUser !== undefined ? latestUser : messages.length,
      { type: "configuration_update", reasoning: { effort: event.reasoningEffort } });
  }
  if (added.length) add(messages.length, { type: "additional_tools", role: "developer", tools: structuredClone(added) });
  return { tools: initial.tools, reasoningEffort: updatesEffort ? initial.reasoningEffort : reasoningEffort,
    before, ...(added.length || event.reasoningEffort !== undefined ? { event } : {}) };
}
