import { LLMMissingCredentialsError } from "../llm/errors.js";
import { resolveBuiltInProviderInfo, providerCredentialEnvironmentLabel } from "../llm/registry/provider-info.js";

/** Emit only recognized diagnostics. Arbitrary exception text can contain credentials. */
export function telegramSessionFailure(error: unknown): { code: string; diagnostic: string; reply: string } {
  const value = error as { message?: unknown; code?: unknown; data?: { code?: unknown } } | null;
  const message = typeof value?.message === "string" ? value.message : "";
  // Only trusted local exceptions carry provider identity. Never echo arbitrary
  // error messages: credential diagnostics can contain provider payloads.
  if (error instanceof LLMMissingCredentialsError && resolveBuiltInProviderInfo(error.providerName)) {
    const provider = error.providerName;
    const label = provider === "anthropic" ? "ANTHROPIC_API_KEY or ANTHROPIC_AUTH_TOKEN"
      : providerCredentialEnvironmentLabel(provider);
    const hint = resolveBuiltInProviderInfo(provider)?.onboarding.supportsManagedKeyAccess
      ? " or sign in and enable auth.managedKeys.enabled" : "";
    return { code: "TELEGRAM_PROVIDER_CREDENTIAL_MISSING",
      diagnostic: `${provider} authentication failed (HTTP 401): ${provider} provider requires credentials. Set ${label}${hint}.`,
      reply: `No credential for ${provider} is available to Telegram agents. Open AgenC, connect that provider in Settings, then stop and start this Telegram agent.` };
  }
  const provider = /^(?:([a-z0-9-]+) authentication failed \(HTTP 401\): )?([a-z0-9-]+) provider requires credentials\. Set /u.exec(message)?.[2];
  const info = provider ? resolveBuiltInProviderInfo(provider) : undefined;
  if (info) {
    const hint = info.onboarding.supportsManagedKeyAccess ? " or sign in and enable auth.managedKeys.enabled" : "";
    const reason = `${provider} provider requires credentials. Set ${providerCredentialEnvironmentLabel(provider!)}${hint}.`;
    if (message === reason || message === `${provider} authentication failed (HTTP 401): ${reason}`) {
      return { code: "TELEGRAM_PROVIDER_CREDENTIAL_MISSING", diagnostic: message,
        reply: `No credential for ${provider} is available to Telegram agents. Open AgenC, connect that provider in Settings, then stop and start this Telegram agent.` };
    }
  }
  const code = value?.data?.code ?? value?.code;
  if (code === "REMOTE_WORKSPACE_INVALID" || /^(?:ENOENT|ENOTDIR):/u.test(message)) {
    return { code: "TELEGRAM_WORKSPACE_INVALID", diagnostic: "REMOTE_WORKSPACE_INVALID: workspace is missing or invalid",
      reply: "The workspace folder is unavailable. Open AgenC and choose an existing folder for this Telegram agent." };
  }
  if (code === "REMOTE_SESSION_CREATE_INVALID" || code === -32602 || /(?:unknown|unsupported|invalid) (?:provider|model)/iu.test(message)) {
    return { code: "TELEGRAM_SESSION_CONFIG_INVALID", diagnostic: "Session configuration rejected (provider, model or protocol parameters)",
      reply: "Core rejected the session settings. Open AgenC, check this agent's provider and model, and update Core if needed." };
  }
  const rpcCode = typeof value?.code === "number" && Number.isSafeInteger(value.code) ? ` (RPC ${value.code})` : "";
  return { code: "TELEGRAM_SESSION_CREATE_FAILED", diagnostic: `Unrecognized session creation failure${rpcCode}; raw text withheld to protect credentials`,
    reply: "Core could not create the session. Check daemon.log on the host for the failure category, then restart this Telegram agent." };
}
