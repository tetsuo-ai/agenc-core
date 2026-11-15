/**
 * OpenAI freeform (custom) tool form of apply_patch on the Responses API.
 *
 * OpenAI documents custom tools for its GPT-5 and later models: the model
 * writes the tool input as plain text, optionally constrained by a Lark
 * grammar, instead of a JSON object
 * (https://developers.openai.com/api/docs/guides/function-calling#custom-tools).
 * A patch sent this way is not a JSON string, so its newlines, quotes and
 * backslashes are not escaped and it cannot arrive as invalid JSON.
 *
 * Only the wire changes. Inside AgenC the call stays the `apply_patch`
 * function call with `{"input": "<patch>"}` arguments: a `custom_tool_call`
 * output item is read as that call, and that call goes back in history as a
 * `custom_tool_call` with its `custom_tool_call_output`.
 *
 * @module
 */

import { APPLY_PATCH_LARK_GRAMMAR } from "../../tools/apply-patch/grammar.js";

const FREEFORM_TOOL_NAME = "apply_patch";

type Item = Record<string, unknown>;

/** Whether `tool` (a flat Responses function tool) is apply_patch with its one string field. */
function isApplyPatchFunctionTool(tool: Item): boolean {
  if (tool.type !== "function" || tool.name !== FREEFORM_TOOL_NAME) return false;
  const parameters = tool.parameters;
  if (parameters === null || typeof parameters !== "object" || Array.isArray(parameters)) return false;
  const properties = (parameters as Item).properties;
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) return false;
  const fields = Object.keys(properties);
  return fields.length === 1 && fields[0] === "input";
}

/** The freeform declaration of apply_patch; every other tool is returned as it is. */
export function freeformResponsesTool<T extends Item>(tool: T): T | Item {
  if (!isApplyPatchFunctionTool(tool)) return tool;
  return {
    type: "custom",
    name: FREEFORM_TOOL_NAME,
    description: tool.description,
    format: { type: "grammar", syntax: "lark", definition: APPLY_PATCH_LARK_GRAMMAR },
  };
}

/** Whether a named tool choice selects the freeform tool. */
export function isFreeformToolName(name: string): boolean {
  return name === FREEFORM_TOOL_NAME;
}

/**
 * The patch text of an apply_patch call recorded in history, when its
 * arguments are exactly `{"input": "<patch>"}`. Any other call (another tool,
 * extra fields, arguments that are not JSON) keeps the function form.
 */
export function freeformCallInput(name: string, argumentsJson: string): string | undefined {
  if (name !== FREEFORM_TOOL_NAME) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const fields = Object.keys(parsed);
  const input = (parsed as Item).input;
  return fields.length === 1 && typeof input === "string" ? input : undefined;
}

/**
 * A `custom_tool_call` output item as the function call AgenC runs: the same
 * ids and name, with the text as the `input` argument. Other items are
 * returned as they are.
 */
export function functionCallFromCustomToolCall<T extends Item>(item: T): T | Item {
  if (item.type !== "custom_tool_call") return item;
  const { input, ...rest } = item;
  return {
    ...rest,
    type: "function_call",
    arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
  };
}

/** `functionCallFromCustomToolCall` over an output array. */
export function functionCallsFromCustomToolCalls(output: readonly Item[]): Item[] {
  return output.map((item) => functionCallFromCustomToolCall(item));
}
