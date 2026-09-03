import { createHash } from "node:crypto";

/** Publisher identity used by plugins signed and shipped by AgenC. */
export const OFFICIAL_PLUGIN_PUBLISHER = "tetsuo-ai";

/** Base64 DER-SPKI Ed25519 public key for the official AgenC publisher. */
export const OFFICIAL_PLUGIN_PUBLISHER_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAj20DQnldg2gADPiX8xb+7Anc7m8FfdhQYmtqqLUW/+E=";

/** Auditable SHA-256 fingerprint of the decoded DER-SPKI key above. */
export const OFFICIAL_PLUGIN_PUBLISHER_KEY_SHA256 =
  "8174e96296289bd8eed26b832296309015216afe544a7f15097356b10aa1b932";

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

export function pluginPublisherKeyFingerprint(publicKey: string): string {
  return createHash("sha256")
    .update(Buffer.from(publicKey, "base64"))
    .digest("hex");
}
