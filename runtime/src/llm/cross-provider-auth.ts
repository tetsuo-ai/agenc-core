/** The v1 combinations accepted at a child destination. */
export const CROSS_PROVIDER_AUTH_ENDPOINT_COMBINATIONS = Object.freeze([
  { profile: "api_key", providers: "built_in", description: "BYOK API key at the provider's canonical endpoint" },
  { profile: "managed", providers: "built_in", description: "managed AgenC credits at the concrete provider's canonical endpoint" },
  { profile: "local", providers: ["ollama", "lmstudio", "openai-compatible"], description: "local Ollama, LM Studio, or OpenAI-compatible service at its built-in endpoint" },
  { profile: "aws_sigv4", providers: ["amazon-bedrock"], description: "AWS SigV4 at Bedrock's default regional endpoint" },
] as const);

export const CROSS_PROVIDER_AUTH_DESCRIPTION =
  `Supported cross-provider child authority: ${CROSS_PROVIDER_AUTH_ENDPOINT_COMBINATIONS.map((entry) => entry.description).join("; ")}. Sign-in refresh and custom endpoints are unsupported.`;

export type ChildBillingSource = "byok" | "managed" | "local" | "sign_in";
export type ChildAuthProfile = "api_key" | "managed" | "local" | "aws_sigv4" | "sign_in";

export function assertSupportedCrossProviderAuth(
  provider: string,
  authProfile: ChildAuthProfile,
): void {
  if (authProfile === "sign_in") {
    throw new Error(`Cross-provider ${provider} children cannot use sign-in refresh at the canonical endpoint. Use a BYOK API key or managed AgenC credits.`);
  }
  const supported = CROSS_PROVIDER_AUTH_ENDPOINT_COMBINATIONS.some((entry) =>
    entry.profile === authProfile &&
    (entry.providers === "built_in" || (entry.providers as readonly string[]).includes(provider)));
  if (!supported) {
    throw new Error(`Cross-provider ${provider} cannot use ${authProfile} at its canonical endpoint.`);
  }
}
