import { posix } from "node:path";
import { ExecutionEnvironmentError, type ExecutionFileIdentity, type ExecutionPathDescription } from "./types.js";

/** Validate persisted exact metadata without consulting any filesystem. */
export function readExecutionPathDescription(value: unknown): ExecutionPathDescription {
  const invalid = (): never => { throw new ExecutionEnvironmentError("invalid_request", "Invalid execution file description", false); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const { canonicalPath, identity } = value as Partial<ExecutionPathDescription>;
  if (typeof canonicalPath !== "string" || !posix.isAbsolute(canonicalPath) || canonicalPath.includes("\0") ||
      Buffer.byteLength(canonicalPath) >= 16384 || Buffer.from(canonicalPath).toString() !== canonicalPath ||
      !identity || typeof identity !== "object" || Array.isArray(identity)) return invalid();
  const copy = {} as Record<keyof ExecutionFileIdentity, string>;
  for (const key of ["dev", "ino", "mode", "nlink", "size", "mtimeNs", "ctimeNs"] as const) {
    const text = identity[key];
    const signed = key === "mtimeNs" || key === "ctimeNs";
    if (typeof text !== "string" || text.length > 40 || !(signed ? /^-?\d+$/ : /^\d+$/).test(text)) return invalid();
    copy[key] = text;
  }
  return Object.freeze({ canonicalPath, identity: Object.freeze(copy) });
}

export function sameExecutionPathDescription(left: ExecutionPathDescription, right: ExecutionPathDescription): boolean {
  return left.canonicalPath === right.canonicalPath &&
    (Object.keys(left.identity) as (keyof ExecutionFileIdentity)[]).every(key => left.identity[key] === right.identity[key]);
}
