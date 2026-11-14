/**
 * Third-party chat deployments the QwenCloud Token Plan serves beside its
 * Qwen models (live Models API on a Token Plan key, 2026-10-31). Each keeps
 * the wire contract Core already uses for the same DashScope deployment on
 * Pay-As-You-Go (qwen-current-models.ts): limits, thinking mode, effort enum,
 * tool streaming and output field. `deepseek-v4.1-flash-1017` is the dated
 * deployment of `deepseek-v4.1-flash` and shares its limits and controls.
 * Every id answered a parallel two-tool call and its tool-result round trip on
 * the Token Plan endpoint. The plan's `auto` router publishes no limits or
 * controls and is not listed.
 * The separate Qwen4 preview contract below is documentation-only and has no
 * PAYG route. Sources: docs/models/qwen-token-plan-2026-10-31.md and
 * docs/models/qwen4-max-preview-2026-11.md.
 */
import type { RegisteredModelCatalogEntry } from "./model-catalog.js";
import {
  qwenCurrentCatalogEntry,
  resolveQwenCurrentModel,
  type QwenCurrentModel,
} from "./qwen-current-models.js";

/** Plan-only preview, documented 2026-11-13. Never inherit a PAYG contract. */
export const QWEN4_MAX_PREVIEW_MODEL = Object.freeze({
  model: "qwen4-max-preview",
  displayName: "Qwen4 Max Preview",
  contextWindow: 1_000_000,
  // The xhigh thinking budget is 262,144; leave 131,072 for the answer.
  maxOutputTokens: 393_216,
  vision: true,
  thinking: "hybrid",
  totalOutputCap: true,
  reasoningLevels: Object.freeze(["low", "medium", "xhigh"] as const),
  defaultReasoningLevel: "xhigh",
  supportsStructuredOutput: true,
  // November 25 at 24:00 UTC+8 is November 26 at 00:00 UTC+8.
  retiresOn: "2026-11-26",
} satisfies QwenCurrentModel);

export const QWEN_TOKEN_PLAN_PREVIEW_MODEL_IDS: readonly string[] = Object.freeze([
  QWEN4_MAX_PREVIEW_MODEL.model,
  "qwen4.0-max-preview",
]);

export function isQwen4MaxPreviewModel(model: string | undefined): boolean {
  return QWEN_TOKEN_PLAN_PREVIEW_MODEL_IDS.includes(model?.trim().toLowerCase() ?? "");
}

/** Resolve the billing alias too, without adding a second picker choice. */
export const QWEN_TOKEN_PLAN_PREVIEW_CATALOG: readonly RegisteredModelCatalogEntry[] = Object.freeze(
  QWEN_TOKEN_PLAN_PREVIEW_MODEL_IDS.map((model, index) => qwenCurrentCatalogEntry(
    "qwen-token-plan", { ...QWEN4_MAX_PREVIEW_MODEL, model }, -1,
    index === 0 ? "list" : "none",
  )),
);

const TOKEN_PLAN_HOSTED_CONTRACTS: Readonly<Record<string, string>> = Object.freeze({
  "deepseek-v4.1-flash": "deepseek-v4.1-flash",
  "deepseek-v4.1-flash-1017": "deepseek-v4.1-flash",
  "deepseek-v4-pro": "deepseek-v4-pro",
  "deepseek-v4-pro-0813": "deepseek-v4-pro-0813",
  "deepseek-v4-flash-0731": "deepseek-v4-flash-0731",
  "glm-5.3": "glm-5.3",
  "glm-5.2": "glm-5.2",
});

/** Token Plan chat ids beyond its Qwen models, in picker order. */
export const QWEN_TOKEN_PLAN_HOSTED_MODEL_IDS: readonly string[] = Object.freeze(
  Object.keys(TOKEN_PLAN_HOSTED_CONTRACTS),
);

/** The reviewed Token Plan deployment contract, including its plan-only preview. */
export function resolveQwenTokenPlanHostedModel(
  model: string | undefined,
): QwenCurrentModel | undefined {
  const id = model?.trim().toLowerCase();
  if (id === undefined) return undefined;
  if (isQwen4MaxPreviewModel(id)) {
    return id === QWEN4_MAX_PREVIEW_MODEL.model ? QWEN4_MAX_PREVIEW_MODEL
      : Object.freeze({ ...QWEN4_MAX_PREVIEW_MODEL, model: id });
  }
  const source = Object.hasOwn(TOKEN_PLAN_HOSTED_CONTRACTS, id) ? TOKEN_PLAN_HOSTED_CONTRACTS[id] : undefined;
  const contract = source === undefined ? undefined : resolveQwenCurrentModel(source);
  if (contract === undefined) return undefined;
  return contract.model === id
    ? contract
    : Object.freeze({ ...contract, model: id, displayName: `${contract.displayName} (1017 snapshot)` });
}

/** Picker rows for the hosted models, after the plan's Qwen models. */
export const QWEN_TOKEN_PLAN_HOSTED_CATALOG: readonly RegisteredModelCatalogEntry[] = Object.freeze(
  QWEN_TOKEN_PLAN_HOSTED_MODEL_IDS.flatMap((id, index) => {
    const entry = resolveQwenTokenPlanHostedModel(id);
    return entry === undefined ? [] : [qwenCurrentCatalogEntry("qwen-token-plan", entry, 12 + index, "list")];
  }),
);
