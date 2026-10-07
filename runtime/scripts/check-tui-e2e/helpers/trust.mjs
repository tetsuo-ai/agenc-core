/**
 * Shared steps for the project trust scenarios. These scenarios set
 * `meta.preTrust = false`, so the session starts in a folder the gate did not
 * trust in advance.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

export const TRUST_CARD = /Trust\s*this\s*project\?/u;

/** Make the session folder ship one repository hook, so trust needs review. */
export function shipRepoHook(session) {
  const dir = path.join(session.cwd, ".agenc");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "config.toml"),
    'config_version = 2\n[[hooks.Stop]]\nhooks = [{ type = "command", command = "./notify.sh" }]\n',
    "utf8",
  );
}

/** How the session folder is trusted in the gate home: explicit, automatic or none. */
export function trustKind(session, env) {
  const ledgerPath = path.join(env.AGENC_HOME, "trusted-projects.json");
  if (!existsSync(ledgerPath)) return "none";
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  const root = realpathSync(session.cwd);
  const has = (entries) => (entries ?? []).some((entry) => entry.path === root);
  if (has(ledger.trustedProjects)) return "explicit";
  if (has(ledger.autoTrustedProjects)) return "automatic";
  return "none";
}

export function expectTrustKind(session, env, expected, when) {
  const actual = trustKind(session, env);
  if (actual !== expected) {
    throw new Error(`${when}: expected ${expected} trust, found ${actual}`);
  }
}
