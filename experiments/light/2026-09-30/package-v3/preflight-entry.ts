/** Buildable preflight boundary. No Core imports before explicit selection.
 * The actual preflight retains all of its own checks. This wrapper neither
 * approves execution nor supplies deployment, containment, or input authority.
 */
import type { Inputs } from "./preflight.js";
import { verifySelection } from "./preflight-selection.mjs";

export async function runSelectedIndependent(input: Inputs) {
  verifySelection();
  const { prepareIndependent } = await import("./preflight.js");
  return prepareIndependent(input);
}
