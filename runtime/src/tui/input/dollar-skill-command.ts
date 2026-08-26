import type { ContentBlockParam } from "@anthropic-ai/sdk/resources/messages.mjs";

import { addInvokedSkill, getSessionId } from "../../bootstrap/state.js";
import type { Command } from "../../commands.js";
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
} from "../../constants/xml.js";
import { AdmissionDeniedError } from "../../budget/admission-client.js";
import { parseToolRuleStringsFromCLI } from "../../permissions/settings.js";
import { runWithCurrentRuntimeSession } from "../../session/current-session.js";
import type { Session } from "../../session/session.js";
import { isRepositoryControlledSkillSource } from "../../skills/repository-skill-boundary.js";
import type { EffortValue } from "../../utils/effort.js";
import { registerSkillHooks } from "../../utils/hooks/registerSkillHooks.js";
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from "../../utils/settings/pluginOnlyPolicy.js";
import { escapeXml } from "../../utils/xml.js";
import type { PromptInputContext } from "./inputContext.js";

interface ParsedDollarSkillCommand {
  readonly commandName: string;
  readonly args: string;
}

interface LoadedDollarSkillCommand {
  readonly metadata: string;
  readonly blocks: ContentBlockParam[];
  readonly skillContent: string;
  readonly allowedTools?: string[];
  readonly model?: string;
  readonly effort?: EffortValue;
}

export function parseDollarSkillCommand(
  input: string,
): ParsedDollarSkillCommand | null {
  const lines = input.split("\n");
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]!.trim().length > 0) return null;
  }
  let first = lines[0]!;
  if (first.endsWith("\r")) first = first.slice(0, -1);
  first = first.trim();
  const match = /^\$([A-Za-z.][A-Za-z0-9_.:-]*)(?:\s+(.*))?$/.exec(first);
  if (match === null) return null;
  return {
    commandName: match[1]!,
    args: (match[2] ?? "").trim(),
  };
}

export function isDollarSkillCommand(
  command: unknown,
): command is Extract<Command, { type: "prompt" }> {
  return (
    command !== null &&
    typeof command === "object" &&
    (command as Command).type === "prompt" &&
    ((command as Command).loadedFrom === "skills" ||
      (command as Command).loadedFrom === "plugin" ||
      (command as Command).loadedFrom === "mcp")
  );
}

export async function loadDollarSkillCommandForTurn(
  parsed: ParsedDollarSkillCommand,
  command: Extract<Command, { type: "prompt" }>,
  context: PromptInputContext,
): Promise<LoadedDollarSkillCommand> {
  const loadPrompt = () => command.getPromptForCommand(parsed.args, context);
  const blocks = isMcpPromptCommand(command)
    ? await runWithCurrentRuntimeSession(
        requireMcpPromptSession(context),
        loadPrompt,
      )
    : await loadPrompt();
  const skillContent = blocks
    .filter(
      (block): block is Extract<ContentBlockParam, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n\n");
  const skillPath = command.skillRoot
    ? `${command.skillRoot}:${command.name}`
    : command.source
      ? `${command.source}:${command.name}`
      : command.name;

  addInvokedSkill(command.name, skillPath, skillContent, null);

  const repositoryControlled = isRepositoryControlledSkillSource(
    command.source,
  );
  const hooksAllowed =
    !repositoryControlled &&
    (!isRestrictedToPluginOnly("hooks") ||
      isSourceAdminTrusted(command.source));
  if (command.hooks && hooksAllowed) {
    registerSkillHooks(
      context.setAppState,
      getSessionId(),
      command.hooks,
      command.name,
      command.skillRoot,
    );
  }

  return {
    metadata: formatDollarSkillInputTags(command.name, parsed.args),
    blocks,
    skillContent,
    allowedTools: repositoryControlled
      ? []
      : parseToolRuleStringsFromCLI(command.allowedTools ?? []),
    model: repositoryControlled ? undefined : command.model,
    effort: repositoryControlled ? undefined : command.effort,
  };
}

function formatDollarSkillInputTags(commandName: string, args: string): string {
  const escapedCommandName = escapeXml(commandName);
  const escapedArgs = escapeXml(args);
  return `<${COMMAND_NAME_TAG}>$${escapedCommandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${escapedCommandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${escapedArgs}</${COMMAND_ARGS_TAG}>
            <skill-format>true</skill-format>`;
}

function isMcpPromptCommand(
  command: Extract<Command, { type: "prompt" }>,
): boolean {
  return (
    command.source === "mcp" ||
    command.loadedFrom === "mcp" ||
    command.isMcp === true
  );
}

function requireMcpPromptSession(context: PromptInputContext): Session {
  const candidate = context.session;
  if (
    candidate === null ||
    typeof candidate !== "object" ||
    typeof (candidate as { conversationId?: unknown }).conversationId !==
      "string" ||
    (candidate as { services?: unknown }).services === null ||
    typeof (candidate as { services?: unknown }).services !== "object"
  ) {
    throw new AdmissionDeniedError(
      "mcp_prompt_admission_identity_unavailable",
    );
  }
  return candidate as Session;
}
