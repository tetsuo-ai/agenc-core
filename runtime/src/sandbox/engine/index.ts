/**
 * Cross-platform sandbox engine: the policy model (`policy.ts`), the manager
 * and the platform backends. Code that needs only the policy model, such as
 * the Linux launcher process, imports `policy.ts` and skips the manager's
 * dependency graph.
 */
export * from "./policy.js";
export { SandboxManager, compatibilitySandboxPolicyForPermissionProfile } from "./manager.js";
export { createLinuxSandboxCommandArgsForPermissionProfile } from "./landlock.js";
export { createSeatbeltCommandArgs } from "./seatbelt.js";
