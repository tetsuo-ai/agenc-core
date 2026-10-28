/**
 * What each built-in provider does with API prompts and responses, and which
 * zero data retention (ZDR) control AgenC can use for it.
 *
 * Checked against each provider's own documentation on 2026-10-22. The URLs
 * are the evidence; re-check them when a provider changes its terms. The
 * classes:
 *
 * - `request-zdr`: a per-request ZDR control. AgenC sends it by default and
 *   explicit config can turn it off (OpenRouter `provider.zdr`).
 * - `no-retention`: the provider's policy says API prompts and responses are
 *   not stored or logged. Nothing to send or enable.
 * - `per-model`: retention depends on the model (Venice: private models keep
 *   nothing, anonymized models are hosted by third parties).
 * - `account-level`: the provider keeps API data by default and offers ZDR
 *   only through an account, organization, project or team setting, or a
 *   contract. AgenC cannot see that setting.
 * - `retains`: no ZDR offered for this API, or the terms allow keeping or
 *   using the data.
 * - `local`: the server runs on this computer by default.
 *
 * `requestPrivacy` lists request parameters AgenC already sends by default
 * because they keep data off the provider's servers.
 */

import type { BuiltInProviderSlug } from "./provider-info.js";

export type ProviderRetentionClass =
  | "request-zdr"
  | "no-retention"
  | "per-model"
  | "account-level"
  | "retains"
  | "local";

export interface ProviderRetentionFacts {
  readonly retention: ProviderRetentionClass;
  /** One plain sentence for /status and the docs. */
  readonly summary: string;
  /** Request parameters AgenC sends by default for privacy. */
  readonly requestPrivacy?: readonly string[];
  /** The provider documentation the class rests on. */
  readonly docs: readonly string[];
}

/** The day the documentation behind this table was last read. */
export const PROVIDER_RETENTION_CHECKED_ON = "2026-10-22";

function facts(entry: ProviderRetentionFacts): ProviderRetentionFacts {
  return Object.freeze({
    ...entry,
    docs: Object.freeze([...entry.docs]),
    ...(entry.requestPrivacy === undefined
      ? {}
      : { requestPrivacy: Object.freeze([...entry.requestPrivacy]) }),
  });
}

const LOCAL_SUMMARY = "Runs on this computer. Nothing leaves it unless the server address points elsewhere.";

export const PROVIDER_RETENTION: Readonly<Record<Exclude<BuiltInProviderSlug, "agenc">, ProviderRetentionFacts>> = Object.freeze({
  grok: facts({
    retention: "account-level",
    summary: "xAI keeps every API request and response for 30 days. ZDR is a team setting in the xAI Console.",
    docs: [
      "https://docs.x.ai/developers/faq/security",
      "https://docs.x.ai/developers/model-capabilities/text/generate-text",
    ],
  }),
  openai: facts({
    retention: "account-level",
    summary: "OpenAI keeps abuse-monitoring logs for up to 30 days. ZDR needs an approved organization or project.",
    requestPrivacy: ["store: false"],
    docs: ["https://developers.openai.com/api/docs/guides/your-data"],
  }),
  anthropic: facts({
    retention: "account-level",
    summary: "Anthropic may keep API data for up to 30 days and flagged content longer. ZDR is an organization agreement.",
    docs: [
      "https://privacy.claude.com/en/articles/7996866",
      "https://platform.claude.com/docs/en/manage-claude/api-and-data-retention",
    ],
  }),
  ollama: facts({ retention: "local", summary: LOCAL_SUMMARY, docs: ["https://docs.ollama.com/faq"] }),
  lmstudio: facts({ retention: "local", summary: LOCAL_SUMMARY, docs: [] }),
  "openai-compatible": facts({ retention: "local", summary: LOCAL_SUMMARY, docs: [] }),
  openrouter: facts({
    retention: "request-zdr",
    summary: "Every request carries provider.zdr, so OpenRouter uses only endpoints that keep nothing. OpenRouter itself keeps prompts only if the account turned on prompt logging.",
    requestPrivacy: ["provider.zdr: true"],
    docs: [
      "https://openrouter.ai/docs/guides/features/zdr",
      "https://openrouter.ai/docs/guides/routing/provider-selection",
    ],
  }),
  venice: facts({
    retention: "per-model",
    summary: "Venice keeps nothing for its private models. Anonymized models run on third-party hosts.",
    docs: ["https://docs.venice.ai/overview/privacy"],
  }),
  abliteration: facts({
    retention: "no-retention",
    summary: "abliteration.ai processes prompts in memory and never stores them.",
    docs: ["https://abliteration.ai/data-handling"],
  }),
  groq: facts({
    retention: "account-level",
    summary: "Groq keeps no inference data by default but may log it up to 30 days for troubleshooting or abuse. ZDR is a switch in Data Controls.",
    docs: ["https://console.groq.com/docs/your-data"],
  }),
  deepseek: facts({
    retention: "retains",
    summary: "DeepSeek keeps input while the account exists and offers no ZDR.",
    docs: ["https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html"],
  }),
  meta: facts({
    retention: "account-level",
    summary: "Meta keeps data as needed for the service. ZDR is arranged per organization.",
    requestPrivacy: ["store: false"],
    docs: [
      "https://dev.meta.ai/help/policies-and-privacy/zero-data-retention",
      "https://dev.meta.ai/docs/protocols/responses",
    ],
  }),
  qwen: facts({
    retention: "account-level",
    summary: "Alibaba keeps prompts and responses for up to 30 days. ZDR is for enterprise workspaces.",
    docs: ["https://www.alibabacloud.com/help/en/model-studio/data-retention-policy"],
  }),
  "qwen-token-plan": facts({
    retention: "retains",
    summary: "Alibaba keeps prompts and responses for up to 30 days. Its ZDR program does not cover the Token Plan.",
    docs: [
      "https://www.alibabacloud.com/help/en/model-studio/data-retention-policy",
      "https://www.alibabacloud.com/help/en/model-studio/token-plan-faq",
    ],
  }),
  "ollama-cloud": facts({
    retention: "no-retention",
    summary: "Ollama does not store or log cloud prompts and responses.",
    docs: ["https://docs.ollama.com/faq", "https://ollama.com/privacy"],
  }),
  cerebras: facts({
    retention: "no-retention",
    summary: "Cerebras does not retain inference inputs and outputs.",
    docs: ["https://cerebras.ai/privacy-policy"],
  }),
  zai: facts({
    retention: "retains",
    summary: "Z.AI's no-storage promise covers business customers. Individual terms allow service use, and cache retention is unannounced.",
    docs: [
      "https://docs.z.ai/legal-agreement/privacy-policy",
      "https://docs.z.ai/legal-agreement/terms-of-use",
      "https://docs.z.ai/help/faq",
    ],
  }),
  "zai-coding-plan": facts({
    retention: "retains",
    summary: "Z.AI's no-storage promise covers business customers. Individual plans allow service use, and cache retention is unannounced.",
    docs: [
      "https://docs.z.ai/legal-agreement/privacy-policy",
      "https://docs.z.ai/legal-agreement/terms-of-use",
      "https://docs.z.ai/help/faq",
    ],
  }),
  gemini: facts({
    retention: "retains",
    summary: "The Gemini API logs prompts for abuse monitoring and the free tier trains on them. ZDR is only on Vertex AI.",
    // Since 2026-10-26 new paid projects keep generateContent requests in
    // their AI Studio logs unless a request says store: false. AgenC sends it
    // on the Developer API; it does not stop the abuse-monitoring logs.
    requestPrivacy: ["store: false"],
    docs: [
      "https://ai.google.dev/gemini-api/docs/zdr",
      "https://ai.google.dev/gemini-api/terms",
      "https://ai.google.dev/gemini-api/docs/logs-datasets",
    ],
  }),
  kimi: facts({
    // Rechecked 2026-10-23: the privacy policy's section 6 retains input while
    // an account is active. Enterprise ZDR is a server-side policy requested
    // from Moonshot, not an API parameter or a guarantee AgenC can verify.
    // https://platform.kimi.ai/docs/agreement/userprivacy
    // https://platform.kimi.ai/docs/guide/zero-data-retention
    retention: "account-level",
    summary: "Moonshot keeps input while the account is active. ZDR is for enterprise customers on request.",
    docs: [
      "https://platform.kimi.ai/docs/guide/zero-data-retention",
      "https://platform.kimi.ai/docs/agreement/userprivacy",
      "https://platform.kimi.ai/docs/agreement/modeluse",
    ],
  }),
  mistral: facts({
    retention: "account-level",
    summary: "Mistral keeps data 30 days for abuse monitoring. ZDR is granted on request.",
    docs: ["https://docs.mistral.ai/admin/monitor-comply/zero-data-retention"],
  }),
  "nvidia-nim": facts({
    retention: "retains",
    summary: "NVIDIA's API trial terms let NVIDIA keep and use prompts and outputs.",
    docs: [
      "https://assets.ngc.nvidia.com/products/api-catalog/legal/NVIDIA%20API%20Trial%20Terms%20of%20Service.pdf",
    ],
  }),
  minimax: facts({
    retention: "retains",
    summary: "MiniMax keeps data as long as necessary and offers no ZDR.",
    docs: ["https://platform.minimax.io/protocol/privacy-policy"],
  }),
  github: facts({
    retention: "account-level",
    summary: "Upstream models run under ZDR, but GitHub may train on individual-plan interactions unless that is turned off.",
    docs: [
      "https://docs.github.com/en/copilot/reference/ai-models/model-hosting",
      "https://docs.github.com/en/copilot/how-tos/manage-your-account/manage-policies",
    ],
  }),
  "amazon-bedrock": facts({
    retention: "account-level",
    summary: "Bedrock may keep data for abuse detection. ZDR is the account's data_retention_mode none.",
    docs: [
      "https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html",
      "https://docs.aws.amazon.com/bedrock/latest/userguide/abuse-detection.html",
    ],
  }),
} satisfies Record<Exclude<BuiltInProviderSlug, "agenc">, ProviderRetentionFacts>);
