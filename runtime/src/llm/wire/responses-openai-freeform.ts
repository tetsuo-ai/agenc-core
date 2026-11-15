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

/**
 * The models that take custom tools: GPT-5 and later by their own id. The
 * o-series and older GPT models keep the function tool.
 */
export function openAiModelTakesCustomTools(model: string): boolean {
  return /^gpt-(?:[5-9]|[1-9]\d)(?:$|[-_.:\d])/u.test(model.trim().toLowerCase().replace(/^openai[/:]/u, ""));
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
 * A `custom_tool_call` output item for apply_patch as the function call AgenC
 * runs: the same ids and name, with the text as the `input` argument. Only a
 * request that declared the freeform tool (`enabled`) reads one; any other
 * item, a custom call under another name, or a custom call nobody asked for
 * is returned as it is and stays ignored.
 */
export function functionCallFromCustomToolCall<T extends Item>(item: T, enabled: boolean | undefined): T | Item {
  if (enabled !== true || item.type !== "custom_tool_call" || item.name !== FREEFORM_TOOL_NAME) return item;
  const { input, ...rest } = item;
  return {
    ...rest,
    type: "function_call",
    arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
  };
}

/** `functionCallFromCustomToolCall` over an output array. */
export function functionCallsFromCustomToolCalls(output: readonly Item[], enabled: boolean | undefined): Item[] {
  return enabled === true ? output.map((item) => functionCallFromCustomToolCall(item, enabled)) : [...output];
}

/**
 * The key a custom call's issued item id is remembered under. An item id
 * belongs to one item type, so a custom call's id is kept apart from the
 * function-call ids: a call replayed in the other form (the format changed
 * between two requests of a session) finds no id and goes back without one.
 */
export function customToolCallItemIdKey(callId: string): string {
  return `custom:${callId}`;
}

/**
 * The record `ResponsesFunctionCallItemIds` remembers for an output item: a
 * custom call under its own key, every other item as it is.
 */
export function itemIdRecord(item: unknown): unknown {
  if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
  const record = item as Item;
  if (record.type !== "custom_tool_call" || typeof record.call_id !== "string") return item;
  return { type: "function_call", call_id: customToolCallItemIdKey(record.call_id), id: record.id };
}
