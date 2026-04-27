/**
 * Local _deps stub for the gut/AgenC crossing of `../config/env.js`.
 * Provides `resolveApiKey` for the xAI/Grok credential lookup chain that
 * the provider factory consumes. The full env resolver suite stayed in
 * the AgenC port and will be replaced when the config tranche
 * lands.
 */

export type EnvSnapshot = NodeJS.ProcessEnv | Record<string, string | undefined>;

export function resolveApiKey(
  env: EnvSnapshot = process.env,
): string | undefined {
  const xai = env.XAI_API_KEY;
  const grok = env.GROK_API_KEY;
  const agenc = env.AGENC_XAI_API_KEY;
  return (
    (typeof xai === "string" && xai.length > 0 ? xai : undefined) ||
    (typeof grok === "string" && grok.length > 0 ? grok : undefined) ||
    (typeof agenc === "string" && agenc.length > 0 ? agenc : undefined)
  );
}
