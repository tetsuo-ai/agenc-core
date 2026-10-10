import { createPublicKey, verify } from "node:crypto";
import { openSync, readFileSync, closeSync, fstatSync, constants } from "node:fs";
import { isAbsolute } from "node:path";

/** Experimental host-verified progress. The private signing key stays outside the agent.
 * The hard allocation is never raised. A valid receipt releases its second tranche once.
 * Registration and receipts must be retained together across restart; receipt loss fails closed.
 */
export function createTaskBudgetProgress(raw: string, hardTokens: number): () => number {
  const registration = JSON.parse(raw);
  const { initialTokens, nonce, publicKey, receiptPath, commandDigest } = registration;
  if (!Number.isSafeInteger(initialTokens) || initialTokens <= 0 || initialTokens >= hardTokens ||
      typeof nonce !== "string" || nonce.length < 16 || typeof publicKey !== "string" ||
      typeof receiptPath !== "string" || !isAbsolute(receiptPath) ||
      typeof commandDigest !== "string" || !/^[a-f0-9]{64}$/.test(commandDigest)) {
    throw new TypeError("Invalid experimental task budget progress registration");
  }
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new TypeError("Progress requires an Ed25519 host key");
  let granted = false;
  return () => {
    if (granted) return hardTokens;
    let fd: number | undefined;
    try {
      fd = openSync(receiptPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 16_384) return initialTokens;
      const { payload, signature } = JSON.parse(readFileSync(fd, "utf8"));
      if (typeof payload !== "string" || typeof signature !== "string" ||
          !verify(null, Buffer.from(payload), key, Buffer.from(signature, "base64"))) return initialTokens;
      const proof = JSON.parse(payload);
      if (proof.version !== 1 || proof.nonce !== nonce || proof.commandDigest !== commandDigest ||
          proof.initialTokens !== initialTokens || proof.hardTokens !== hardTokens ||
          !Number.isSafeInteger(proof.beforeExitCode) || proof.beforeExitCode <= 0 ||
          proof.afterExitCode !== 0 || proof.timedOut !== false ||
          !/^[a-f0-9]{64}$/.test(proof.beforeWorkspaceDigest ?? "") ||
          !/^[a-f0-9]{64}$/.test(proof.afterWorkspaceDigest ?? "") ||
          proof.beforeWorkspaceDigest === proof.afterWorkspaceDigest) return initialTokens;
      granted = true;
      return hardTokens;
    } catch { return initialTokens; }
    finally { if (fd !== undefined) closeSync(fd); }
  };
}
