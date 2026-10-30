/**
 * Which of two AgenC builds is newer, for decisions that must never start an
 * older runtime over a newer one (the client build check in
 * `daemon-autostart.ts`).
 */

import { order as semverOrder } from "../utils/semver.js";

export interface AgenCRuntimeBuild {
  readonly runtimeVersion: string;
  readonly commit: string;
  readonly buildTime: string;
}

export function sameAgenCRuntimeBuild(
  left: AgenCRuntimeBuild,
  right: AgenCRuntimeBuild,
): boolean {
  return left.runtimeVersion === right.runtimeVersion &&
    left.commit === right.commit &&
    left.buildTime === right.buildTime;
}

/**
 * Order two builds by version, then (same version: a rebuild) by build time.
 * Undefined when the order cannot be told, for example an unparsable version
 * or build time.
 */
export function compareAgenCRuntimeBuilds(
  left: AgenCRuntimeBuild,
  right: AgenCRuntimeBuild,
): -1 | 0 | 1 | undefined {
  let byVersion: -1 | 0 | 1;
  try {
    byVersion = semverOrder(left.runtimeVersion, right.runtimeVersion);
  } catch {
    return undefined;
  }
  if (byVersion !== 0) return byVersion;
  const leftTime = Date.parse(left.buildTime);
  const rightTime = Date.parse(right.buildTime);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return undefined;
  return leftTime === rightTime ? 0 : leftTime < rightTime ? -1 : 1;
}

/** The one line an older client prints when it keeps a newer daemon. */
export function formatKeptNewerDaemonNotice(
  daemon: AgenCRuntimeBuild,
  client: AgenCRuntimeBuild,
): string {
  const order = compareAgenCRuntimeBuilds(daemon, client);
  const runs = daemon.runtimeVersion === client.runtimeVersion
    ? `a ${order === 1 ? "newer" : "different"} build of AgenC ${daemon.runtimeVersion}`
    : `AgenC ${daemon.runtimeVersion}`;
  return `agenc: the daemon runs ${runs} and this agenc is ${client.runtimeVersion}, ` +
    `so the daemon keeps running. Quit and start agenc again to use the same version.`;
}
