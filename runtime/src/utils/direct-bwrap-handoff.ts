const brand = Symbol("prepared direct bubblewrap");
export interface PreparedDirectBwrap { readonly [brand]: true }
export interface DirectBwrapHandoff {
  readonly payload: Buffer;
  readonly sessionSandbox?: {
    readonly program: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly command: readonly string[];
    readonly executable: string;
    readonly policyPaths: readonly string[];
    /**
     * Missing protected metadata paths the namespace leaves unmounted. The
     * session sandbox watches them around every command with the same
     * created-path monitor the per-command launcher runs.
     */
    readonly protectedCreateTargets: readonly string[];
  };
  /** Fixed trusted installed artifact, absent on the legacy V2 handoff. */
  readonly namespaceInitArtifact?: string;
  /**
   * Missing protected metadata paths a per-command launch leaves unmounted.
   * The launcher that dispatches this handoff runs the created-path monitor
   * around the command (only callers that asked for it get such a plan).
   */
  readonly protectedCreateTargets?: readonly string[];
  readonly sourceFd: number | undefined;
  readonly isCurrent: () => boolean;
  readonly dispose: () => void;
}
const prepared = new WeakMap<PreparedDirectBwrap, DirectBwrapHandoff>();

/** Internal planner-to-supervisor registration, never a tool/RPC argument. */
export function registerDirectBwrapPlan(handoff: DirectBwrapHandoff): PreparedDirectBwrap {
  const plan: PreparedDirectBwrap = Object.freeze({ [brand]: true as const });
  prepared.set(plan, Object.freeze({ ...handoff }));
  return plan;
}

/** A serialized or structurally similar object does not carry this authority. */
export function consumeDirectBwrapPlan(plan: PreparedDirectBwrap): DirectBwrapHandoff {
  const handoff = prepared.get(plan);
  if (handoff === undefined) throw new Error("invalid or consumed direct bubblewrap plan");
  prepared.delete(plan);
  return handoff;
}
