const brand = Symbol("prepared direct bubblewrap");
export interface PreparedDirectBwrap { readonly [brand]: true }
export interface DirectBwrapHandoff {
  readonly payload: Buffer;
  /** Fixed trusted installed artifact, absent on the legacy V2 handoff. */
  readonly namespaceInitArtifact?: string;
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
