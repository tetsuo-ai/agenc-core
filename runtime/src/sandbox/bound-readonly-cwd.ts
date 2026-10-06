import path from "node:path";

declare const boundCwdBrand: unique symbol;
export interface BoundReadOnlyCwdCapability { readonly [boundCwdBrand]: true; }

export interface BoundReadOnlyCwdIdentity {
  readonly path: string;
  readonly dev: string;
  readonly ino: string;
  readonly mode: string;
}

const bindings = new WeakMap<object, {
  readonly identity: BoundReadOnlyCwdIdentity;
  readonly isCurrent: () => boolean;
}>();

/** Issued only by the descriptor-owning workspace helper after its bind proof. */
export function issueBoundReadOnlyCwdCapability(
  identity: BoundReadOnlyCwdIdentity,
  isCurrent: () => boolean,
): BoundReadOnlyCwdCapability {
  const capability = Object.freeze({}) as BoundReadOnlyCwdCapability;
  bindings.set(capability, { identity: Object.freeze({ ...identity }), isCurrent });
  return capability;
}

export function readBoundReadOnlyCwdCapability(value: unknown): BoundReadOnlyCwdIdentity {
  const binding = typeof value === "object" && value !== null ? bindings.get(value) : undefined;
  if (binding === undefined || !binding.isCurrent()) {
    throw new Error("narrow inherited cwd requires a current source-owned directory capability");
  }
  return binding.identity;
}

/** Wire data is checked against the launcher's already-held cwd descriptor. */
export function parseBoundReadOnlyCwdIdentity(value: unknown): BoundReadOnlyCwdIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("invalid inherited cwd identity");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "dev,ino,mode,path" ||
      typeof record.path !== "string" || !path.isAbsolute(record.path) || record.path !== path.resolve(record.path) || record.path.includes("\0") ||
      [record.dev, record.ino, record.mode].some((entry) => typeof entry !== "string" || !/^(?:0|[1-9][0-9]{0,30})$/u.test(entry))) {
    throw new Error("invalid inherited cwd identity");
  }
  return record as unknown as BoundReadOnlyCwdIdentity;
}
