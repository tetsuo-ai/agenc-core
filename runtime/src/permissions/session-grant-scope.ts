import { fileEditTargetPath } from "../tools/system/file-edit-target.js";
import { isRecord } from "../utils/record.js";

/** What approving a request for the session covers, in words for a card or a listing. */
export interface SessionGrantScope {
  /** The few words a short or narrow card keeps on its session row. */
  readonly short: string;
  /**
   * The full description. Its scope words come before any tool name, so a
   * long name cut short at the end of a row cannot take them away.
   */
  readonly long: string;
}

export function sessionGrantScope(opts: {
  /** The tool's registry name, which decides how its session grant is keyed. */
  readonly toolName: string;
  /** The tool as the reader sees it named. */
  readonly toolLabel: string;
  readonly input: unknown;
  /**
   * A session grant answers every later call of the tool, whatever its
   * arguments: an MCP tool approved without filesystem-write targets.
   */
  readonly coversAllCalls: boolean;
}): SessionGrantScope {
  if (opts.coversAllCalls) {
    return { short: "all calls", long: `any arguments, every ${opts.toolLabel} call` };
  }
  if (
    (opts.toolName === "Write" || opts.toolName === "Edit") &&
    isRecord(opts.input) &&
    fileEditTargetPath(opts.input) !== undefined
  ) {
    return { short: "this file", long: `${opts.toolLabel} this file only` };
  }
  return { short: "this action", long: "this exact action only" };
}
