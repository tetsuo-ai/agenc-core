import type { LightRequestOptions } from "../../config/schema.js";
import type { LLMMessage } from "../../llm/types.js";
import { LIGHT_WORKSPACE_DATA_BOUNDARY, unframeUntrustedToolResultContent } from "../../tools/untrusted-tool-result-framing.js";
import { verifyToolResultIntegrity, withPersistedToolResultRepresentation } from "../tool-result-integrity.js";
import {
  backgroundStartedNote, timeoutBackgroundedNote,
  RESIDUAL_PROCESSES_NOTE, RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE,
  RESIDUAL_PROCESSES_REPEAT_NOTE, SERVER_CHECK_NOTE, SERVER_CHECK_RUNNING_NOTE,
} from "../../tools/system/exec-result-format.js";

const SHELL = new Set(["exec_command", "write_stdin"]);
const ROUTINE_NOTES = new Set([
  RESIDUAL_PROCESSES_NOTE, RESIDUAL_PROCESSES_NOTE_WITHOUT_SERVER_GUIDANCE,
  RESIDUAL_PROCESSES_REPEAT_NOTE, SERVER_CHECK_NOTE, SERVER_CHECK_RUNNING_NOTE,
]);

function routineNote(line: string): boolean {
  if (ROUTINE_NOTES.has(line)) return true;
  const background = /^\[note: session (\d+) runs in the background\./u.exec(line);
  if (background !== null && line === backgroundStartedNote(Number(background[1]))) return true;
  const timeout = /^\[note: timeoutMs=(\d+) passed .* as session (\d+) instead of stopping it\./u.exec(line);
  return timeout !== null && line === timeoutBackgroundedNote(Number(timeout[1]), Number(timeout[2]));
}

/** Only the runtime footer and trailing routine notes change; stdout stays data. */
export function leanShellResult(text: string): string {
  const footer = /(?:^|\n)\[(exit -?\d+(?: [^\]\n]+)?|exec [^\]\n]+)\](?=\n|$)/gu;
  const matches = [...text.matchAll(footer)];
  const last = matches.at(-1);
  if (last === undefined) return text;
  const end = last.index + last[0].length;
  const suffix = text.slice(end);
  // Unknown text after a footer can be important (errors, sandbox advice).
  // Remove only complete runtime note lines, never arbitrary trailing output.
  const remainder = suffix.replace(/^\[note: [^\n]*\]\n?/gmu,
    note => routineNote(note.trimEnd()) ? "" : note).trim();
  let status = last[1]!.replace(/ (?:wall_time|tokens)=[^\s\]]+/gu, "");
  status = status.replace(/^exec exit_code=(-?\d+)/u, "exit $1")
    .replace(/^exec yielded=true/u, "running");
  if (suffix.includes("Cleanup is complete; those processes are no longer running")) status += " cleanup_complete=true";
  const output = text.slice(0, last.index).replace(/\n+$/u, "");
  return [output, `[${status}]`, remainder].filter(part => part.length > 0).join("\n");
}

function unframeLight(content: LLMMessage["content"]): LLMMessage["content"] {
  const marker = LIGHT_WORKSPACE_DATA_BOUNDARY;
  if (typeof content === "string") {
    return content.startsWith(`${marker}\n`) && content.endsWith(`\n${marker}`)
      ? content.slice(marker.length + 1, -marker.length - 1) : content;
  }
  const first = content[0];
  const last = content.at(-1);
  return first?.type === "text" && first.text === marker && last?.type === "text" && last.text === marker
    ? content.slice(1, -1) : content;
}

export function leanLightResults(messages: readonly LLMMessage[], options: Required<LightRequestOptions>): readonly LLMMessage[] {
  if (!options.compact_tool_results && options.tool_result_markers) return messages;
  const names = new Map<string, string>();
  return messages.map(message => {
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    if (message.role !== "tool") return message;
    const name = message.toolName ?? names.get(message.toolCallId ?? "") ?? "unknown";
    const integrity = message.runtimeOnly?.toolResultIntegrity;
    // Do not repair or endorse corrupt history. The normal integrity guard owns it.
    if (integrity !== undefined && verifyToolResultIntegrity({ toolCallId: message.toolCallId ?? "", content: message.content, integrity }).status !== "valid") return message;
    let content = message.content;
    if (!options.tool_result_markers) content = unframeLight(unframeUntrustedToolResultContent(name, content));
    if (options.compact_tool_results && SHELL.has(name)) {
      if (typeof content === "string") {
        const marker = LIGHT_WORKSPACE_DATA_BOUNDARY;
        const framed = content.startsWith(`${marker}\n`) && content.endsWith(`\n${marker}`);
        content = framed ? `${marker}\n${leanShellResult(content.slice(marker.length + 1, -marker.length - 1))}\n${marker}` : leanShellResult(content);
      } else {
        content = content.map(part => part.type === "text" ? { ...part, text: leanShellResult(part.text) } : part);
      }
    }
    if (content === message.content) return message;
    return { ...message, content,
      ...(integrity === undefined ? {} : { runtimeOnly: { ...message.runtimeOnly,
        toolResultIntegrity: withPersistedToolResultRepresentation(integrity, "compacted", content),
      } }),
    };
  });
}
