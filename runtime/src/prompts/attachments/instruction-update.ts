import type { AttachmentProducer } from "./orchestrator.js";
import { takeInstructionHeadUpdate } from "../instruction-head.js";

/**
 * Tells the model that the workspace instructions or the persistent memory
 * index changed since the session started. The head of the prompt keeps the
 * session-start version so the provider's cached prefix survives; the current
 * version rides here and stays in place through the attachment ledger.
 */
export const instructionUpdateProducer: AttachmentProducer = async (
  opts,
  trackingState,
) => {
  if (opts.subagentDepth > 0) return [];
  const update = takeInstructionHeadUpdate(trackingState);
  if (update === undefined) return [];
  return [
    {
      kind: "instruction_update",
      ...(update.workspaceText !== undefined
        ? { workspaceText: update.workspaceText }
        : {}),
      ...(update.memoryText !== undefined ? { memoryText: update.memoryText } : {}),
    },
  ];
};
