import type { ChildTerminalOutcome } from "./child-terminal.js";
import type { TaskFeatures } from "./provider-selector-irt.js";
import type { RoutingVerification } from "./provider-selector-v2.js";

/** Host-owned task checks. Never populate this service from model tool arguments. */
export interface ChildRoutingVerifier {
  prepare(request: { readonly prompt: string; readonly features: TaskFeatures }): Promise<TrustedChildVerification | undefined>;
}
export interface TrustedChildVerification extends RoutingVerification {
  /** Must verify the exact task artifact/answer; neither self-report nor clean completion is sufficient. */
  check(terminal: ChildTerminalOutcome): Promise<"pass" | "fail" | "unavailable">;
}
