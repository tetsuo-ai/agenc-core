/**
 * Lean tool-result storage stub for `phases/prepare-context.ts`.
 *
 * The upstream `utils/toolResultStorage.ts::applyToolResultBudget`
 * implements I-88 per-turn tool-result byte budgeting with on-disk
 * persistence. The lean rebuild has not yet ported that subsystem;
 * this stub satisfies the call signature with a pass-through so
 * prepare-context still compiles without dragging in the openclaude
 * port. Replace with a real port when the budgeter lands in gut.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ToolResultReplacementRecord = any;

export interface ApplyToolResultBudgetResult<T> {
  readonly messages: T;
  readonly newlyReplaced: ReadonlyArray<ToolResultReplacementRecord>;
}

export async function applyToolResultBudget<T>(
  messages: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars
  _state?: any,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _writeToTranscript?: (
    records: ReadonlyArray<ToolResultReplacementRecord>,
  ) => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _skipToolNames?: ReadonlySet<string>,
): Promise<ApplyToolResultBudgetResult<T>> {
  return { messages, newlyReplaced: [] };
}
