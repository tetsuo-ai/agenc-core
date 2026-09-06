import { createHash } from "node:crypto";

/** Publisher identity used by plugins signed and shipped by AgenC. */
export const OFFICIAL_PLUGIN_PUBLISHER = "tetsuo-ai";

/** Legacy official key. Retained for existing API consumers and old releases. */
export const OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAj20DQnldg2gADPiX8xb+7Anc7m8FfdhQYmtqqLUW/+E=";

/** Auditable SHA-256 fingerprint of the decoded DER-SPKI key above. */
export const OFFICIAL_PLUGIN_PUBLISHER_KEY_SHA256 =
  "8174e96296289bd8eed26b832296309015216afe544a7f15097356b10aa1b932";

/** Approved rollover key, added without revoking historical signatures. */
export const OFFICIAL_PLUGIN_PUBLISHER_ROLLOVER_PUBLIC_KEY =
  "MCowBQYDK2VwAyEALKLkrC3bd6y79NUw5HDmnCbs5A4sxqPb5f7TUVLJang=";
export const OFFICIAL_PLUGIN_PUBLISHER_ROLLOVER_KEY_SHA256 =
  "d3cd019ab546d8512619fabc80cb4b363c66d1a70bfa25a35bbef5aacf3836c3";

const OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEYS: readonly string[] = Object.freeze([
  OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY,
  OFFICIAL_PLUGIN_PUBLISHER_ROLLOVER_PUBLIC_KEY,
]);

/**
 * AgenC ships its own publisher root so a clean profile can verify official
 * plugins without first downloading or hand-writing a trust file. Third-party
 * publishers remain exclusively controlled by the operator keyring.
 */
export function builtInPluginPublisherPublicKey(
  publisher: string,
): string | undefined {
  return publisher === OFFICIAL_PLUGIN_PUBLISHER
    ? OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY
    : undefined;
}

/** Only a release-reviewed built-in trust set; never populated from a catalog. */
export function builtInPluginPublisherPublicKeys(
  publisher: string,
): readonly string[] | undefined {
  return publisher === OFFICIAL_PLUGIN_PUBLISHER
    ? OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEYS
    : undefined;
}

export function pluginPublisherKeyFingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex");
}
