import type { LLMProvider } from "../../src/llm/types.js";
import type { TokenAccountingRequest } from "../../src/llm/token-accounting.js";

/** Model the counter at the actual prepared dispatch, independently of usage
 * reported by the preceding sample. Include all request components. */
export function installPreparedCompactionPressure(
  provider: LLMProvider,
  count: (request: TokenAccountingRequest) => number,
): void {
  Object.assign(provider, { tokenCountCapability: {
    runsLocally: true,
    capabilityVersion: "prepared-compaction-contract-v1",
    adapterRevision: "1",
    configurationRevision: Math.random().toString(36),
    countTokens: async (request: TokenAccountingRequest) => ({
      inputTokens: count(request), complete: true, confidence: "exact",
      countedComponents: ["system", "messages", "tools", "provider_framing"],
    }),
  } });
}
