import { STATUS } from "./checklist-utils.mjs";

export function collectIncompleteZFinalPredecessors(items) {
  return items
    .filter((candidate) => candidate.id !== "Z-FINAL" && /^(?:Z-|ZC-)/.test(candidate.id))
    .filter((candidate) => !candidate.dependsOn.includes("Z-FINAL"))
    .filter((candidate) => candidate.statusToken !== STATUS.DONE);
}
