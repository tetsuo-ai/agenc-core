import { assertNoObsoleteConfigEnvironment } from "./env.js";
import { assertNoRetiredConfigDir } from "./home.js";
import { assertNoRetiredAgentRuntimeEnvironment } from "../session/runtime-options.js";

export type RuntimeIngressEnvironment = Readonly<
  Record<string, string | undefined>
>;

/** Validate retired and superseded process inputs once at a runtime ingress. */
export function assertCanonicalEnvironmentIngress(
  environment: RuntimeIngressEnvironment,
): void {
  assertNoRetiredAgentRuntimeEnvironment(environment);
  assertNoRetiredConfigDir(environment);
  assertNoObsoleteConfigEnvironment(environment);
}
