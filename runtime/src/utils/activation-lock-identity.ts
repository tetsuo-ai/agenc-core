// The launcher owns these identities because standalone install runs before
// @tetsuo-ai/runtime exists. Bundle the same module into the runtime updater.

import {
  existingAgenCHomeIdentity as existingAgenCHomeIdentityImplementation,
  resolveActivationLockRegistry as resolveActivationLockRegistryImplementation,
  wrapperActivationLockPath as wrapperActivationLockPathImplementation,
} from "../../../packages/agenc/lib/activation-lock-identity.mjs";

export function existingAgenCHomeIdentity(requested: string): string | undefined {
  return existingAgenCHomeIdentityImplementation(requested);
}

export function resolveActivationLockRegistry(): string {
  return resolveActivationLockRegistryImplementation();
}

export function wrapperActivationLockPath(wrapperPath: string, registry: string): string {
  return wrapperActivationLockPathImplementation(wrapperPath, registry);
}
