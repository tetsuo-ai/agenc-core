import type { FunctionCallOutputContentItem } from "../context.js";
import type { ToolResult } from "../types.js";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  type CodeModeRuntimeResponse,
} from "./types.js";

export interface CodeModeToolResultOptions {
  readonly maxOutputTokens?: number;
}

function seconds(durationMs: number): string {
  return (durationMs / 1000).toFixed(1);
}

function renderContentItem(item: FunctionCallOutputContentItem): string {
  if (item.type === "input_text") return item.text;
  const suffix = item.detail ? ` detail=${item.detail}` : "";
  return `[image ${item.image_url}${suffix}]`;
}

function renderContentItems(
  contentItems: readonly FunctionCallOutputContentItem[],
): string {
  return contentItems.map(renderContentItem).join("\n");
}

function truncateApproxTokens(text: string, maxOutputTokens: number): string {
  if (!Number.isFinite(maxOutputTokens) || maxOutputTokens <= 0) return text;
  const maxChars = Math.max(256, Math.floor(maxOutputTokens * 4));
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[output truncated to approximately ${maxOutputTokens} tokens]`;
}

export function codeModeRuntimeResponseToToolResult(
  response: CodeModeRuntimeResponse,
  options: CodeModeToolResultOptions = {},
): ToolResult {
  const maxOutputTokens =
    options.maxOutputTokens !== undefined
      ? options.maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
  const output = renderContentItems(response.contentItems);
  const lines: string[] = [];

  switch (response.type) {
    case "yielded":
      lines.push(`Script running with cell ID ${response.cellId}`);
      break;
    case "terminated":
      lines.push("Script terminated");
      break;
    case "result":
      lines.push(response.errorText ? "Script failed" : "Script completed");
      break;
  }

  lines.push(`Wall time ${seconds(response.durationMs)} seconds`);
  if (output.length > 0) {
    lines.push("Output:");
    lines.push(output);
  }
  if (response.type === "result" && response.errorText) {
    lines.push("Script error:");
    lines.push(response.errorText);
  }

  const content = truncateApproxTokens(lines.join("\n"), maxOutputTokens);
  const richItems: FunctionCallOutputContentItem[] = [
    { type: "input_text", text: lines.slice(0, 2).join("\n") },
  ];
  if (response.contentItems.length > 0) richItems.push(...response.contentItems);
  if (response.type === "result" && response.errorText) {
    richItems.push({
      type: "input_text",
      text: `Script error:\n${response.errorText}`,
    });
  }

  return {
    content,
    isError: response.type === "result" && response.errorText !== undefined,
    contentItems: richItems,
    metadata: {
      codeMode: true,
      cellId: response.cellId,
      responseType: response.type,
      durationMs: response.durationMs,
    },
  };
}
