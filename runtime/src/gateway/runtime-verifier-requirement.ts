import type { TurnExecutionContract } from "../llm/turn-execution-contract-types.js";
import type { RuntimeContractFlags } from "../runtime-contract/types.js";

export function isRuntimeVerifierRequiredForTurn(params: {
  readonly flags:
    | Pick<RuntimeContractFlags, "verifierRuntimeRequired">
    | undefined;
  readonly turnExecutionContract:
    | Pick<TurnExecutionContract, "turnClass" | "targetArtifacts">
    | undefined;
}): boolean {
  if (params.flags?.verifierRuntimeRequired !== true) {
    return false;
  }
  if (params.turnExecutionContract?.turnClass !== "workflow_implementation") {
    return false;
  }
  return (params.turnExecutionContract.targetArtifacts?.length ?? 0) > 0;
}
