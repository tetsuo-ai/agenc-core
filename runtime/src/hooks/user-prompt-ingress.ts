import type { ConfigStore } from "../config/store.js";
import type { LLMContentPart } from "../llm/types.js";
import {
  expandFileMentions,
  extractMentionAllowedRoots,
  formatFileMentionRejection,
  type FileMentionRejection,
} from "../prompts/file-mentions.js";
import { renderHookAdditionalContextSection } from "../prompts/hook-context-framing.js";
import { seedFileMentionSessionReads } from "../session/file-mention-session-reads.js";
import type { Session } from "../session/session.js";
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from "./user-prompt-submit.js";
import { isHookExecutionSuppressed } from "./runtime-policy.js";

const MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH = 10_000;

export interface PreparedUserPrompt {
  readonly blocked: boolean;
  readonly input: string | readonly LLMContentPart[];
  readonly displayInput?: string;
  readonly blockMessage?: string;
}

export function userPromptDisplayText(
  input: string | readonly LLMContentPart[],
): string {
  if (typeof input === "string") return input;
  return input
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "image_url") return "[image]";
      return "[document]";
    })
    .filter((part) => part.length > 0)
    .join("\n");
}

/**
 * A mention with no path separator and no extension: the shape of a plugin
 * id or skill name (`@motor3d`), never of a file path (`@src/app.ts`,
 * `@README.md`). Same token shape `rankSkillsForRequest` treats as a plugin
 * mention when it surfaces that plugin's skills.
 */
const BARE_MENTION_TOKEN = /^[a-z0-9][a-z0-9:_-]*$/iu;

const NO_KNOWN_MENTION_NAMES: ReadonlySet<string> = new Set();

type KnownMentionNamesLoader = () => Promise<ReadonlySet<string>>;

/**
 * Installed plugin ids plus loaded skill names and aliases, lowercased.
 *
 * Read through the session's skills manager with the same config snapshot
 * `run-turn.ts` hands the skill listing (the source of `rankSkillsForRequest`),
 * so this hits the snapshot the turn loads anyway. A failing lookup keeps the
 * plain file-mention behavior rather than blocking the prompt.
 */
async function loadKnownMentionNames(params: {
  readonly session: Session;
  readonly configStore: Pick<ConfigStore, "current">;
}): Promise<ReadonlySet<string>> {
  try {
    const outcome = await params.session.services.skillsManager.skillsForConfig(
      params.configStore.current(),
      null,
    );
    const names = new Set<string>();
    for (const skill of outcome.availableSkills ?? []) {
      names.add(skill.name.toLowerCase());
      for (const alias of skill.aliases ?? []) names.add(alias.toLowerCase());
      if (skill.pluginId !== undefined) names.add(skill.pluginId.toLowerCase());
    }
    return names;
  } catch {
    return NO_KNOWN_MENTION_NAMES;
  }
}

/** Loads the known names at most once per prepared prompt, and only on demand. */
function createKnownMentionNamesLoader(params: {
  readonly session: Session;
  readonly configStore: Pick<ConfigStore, "current">;
}): KnownMentionNamesLoader {
  let pending: Promise<ReadonlySet<string>> | undefined;
  return () => (pending ??= loadKnownMentionNames(params));
}

/**
 * A bare token with no regular file behind it. `unreadable` covers a missing
 * path (and the rare existing file that cannot be read), `not_file` a
 * directory. Every other reason means a real file was found, so its warning
 * is about that file and stays.
 */
function isBareMentionWithoutFile(rejection: FileMentionRejection): boolean {
  return (
    (rejection.reason === "unreadable" || rejection.reason === "not_file") &&
    BARE_MENTION_TOKEN.test(rejection.raw)
  );
}

/**
 * Drop the "could not be read" warning for `@plugin-id` and `@skill-name`
 * mentions. Those are first-class mentions: `rankSkillsForRequest` surfaces
 * the plugin's skills and the model calls the Skill tool, so the file warning
 * is noise in the transcript and the errors log.
 *
 * The file lookup always runs first. A readable regular file named like a
 * plugin id is attached as usual and never reaches `rejected`, so the file
 * wins; only the "no such file" outcome is reinterpreted, and only for a
 * bare token that matches a known plugin id, skill name, or skill alias.
 */
async function selectFileMentionWarnings(
  rejected: readonly FileMentionRejection[],
  loadKnownNames: KnownMentionNamesLoader,
): Promise<readonly FileMentionRejection[]> {
  if (!rejected.some(isBareMentionWithoutFile)) return rejected;
  const knownNames = await loadKnownNames();
  return rejected.filter(
    (rejection) =>
      !(
        isBareMentionWithoutFile(rejection) &&
        knownNames.has(rejection.raw.toLowerCase())
      ),
  );
}

function emitFileMentionWarnings(
  session: Session,
  rejections: readonly FileMentionRejection[],
): void {
  for (const rejection of rejections) {
    session.emit({
      id: session.nextInternalSubId(),
      msg: {
        type: "warning",
        payload: {
          cause: "file_mention_attachment_dropped",
          message: formatFileMentionRejection(rejection),
          ...{
            path: rejection.raw,
            reason: rejection.reason,
          },
        },
      },
    });
  }
}

async function expandTextFileMentions(params: {
  readonly session: Session;
  readonly configStore: Pick<ConfigStore, "current">;
  readonly input: string;
  readonly loadKnownMentionNames: KnownMentionNamesLoader;
}): Promise<{ readonly input: string; readonly expanded: boolean }> {
  const cwd = params.session.sessionConfiguration.cwd ?? process.cwd();
  const expansion = await expandFileMentions(params.input, {
    cwd,
    allowedRoots: extractMentionAllowedRoots(params.configStore.current()),
  });
  emitFileMentionWarnings(
    params.session,
    await selectFileMentionWarnings(
      expansion.rejected,
      params.loadKnownMentionNames,
    ),
  );
  if (expansion.attachments.length === 0) {
    return { input: params.input, expanded: false };
  }
  await seedFileMentionSessionReads(
    params.session.conversationId,
    expansion.attachments,
  );
  return { input: expansion.prompt, expanded: true };
}

async function expandPromptFileMentions(params: {
  readonly session: Session;
  readonly configStore?: Pick<ConfigStore, "current">;
  readonly input: string | readonly LLMContentPart[];
}): Promise<{
  readonly input: string | readonly LLMContentPart[];
  readonly displayInput: string;
}> {
  const displayInput = userPromptDisplayText(params.input);
  if (params.configStore === undefined) {
    return { input: params.input, displayInput };
  }
  const loadKnownMentionNames = createKnownMentionNamesLoader({
    session: params.session,
    configStore: params.configStore,
  });
  if (typeof params.input === "string") {
    const expanded = await expandTextFileMentions({
      session: params.session,
      configStore: params.configStore,
      input: params.input,
      loadKnownMentionNames,
    });
    return { input: expanded.input, displayInput };
  }

  let changed = false;
  const parts: LLMContentPart[] = [];
  for (const part of params.input) {
    if (part.type !== "text") {
      parts.push(part);
      continue;
    }
    const expanded = await expandTextFileMentions({
      session: params.session,
      configStore: params.configStore,
      input: part.text,
      loadKnownMentionNames,
    });
    changed ||= expanded.expanded;
    parts.push(expanded.expanded ? { ...part, text: expanded.input } : part);
  }
  return {
    input: changed ? parts : params.input,
    displayInput,
  };
}

function truncateUserPromptSubmitContext(context: string): string {
  if (context.length <= MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH) return context;
  return `${context.substring(0, MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH)}… [output truncated - exceeded ${MAX_USER_PROMPT_SUBMIT_CONTEXT_LENGTH} characters]`;
}

function formatUserPromptSubmitContexts(contexts: readonly string[]): string {
  return (
    renderHookAdditionalContextSection(
      contexts.map((context) => ({
        hookName: "UserPromptSubmit",
        hookEvent: "UserPromptSubmit",
        content: truncateUserPromptSubmitContext(context),
      })),
    ) ?? ""
  );
}

function appendUserPromptSubmitContexts(
  input: string | readonly LLMContentPart[],
  contexts: readonly string[],
): string | readonly LLMContentPart[] {
  if (contexts.length === 0) return input;
  const contextText = formatUserPromptSubmitContexts(contexts);
  if (contextText.length === 0) return input;
  if (typeof input === "string") {
    return input.trim().length > 0 ? `${input}\n\n${contextText}` : contextText;
  }
  const next = [...input];
  const last = next[next.length - 1];
  if (last?.type === "text") {
    next[next.length - 1] = {
      ...last,
      text: `${last.text}\n\n${contextText}`,
    };
    return next;
  }
  next.push({ type: "text", text: contextText });
  return next;
}

function appendUserPromptSubmitContextsToMessage(
  message: string,
  contexts: readonly string[],
): string {
  if (contexts.length === 0) return message;
  const contextText = formatUserPromptSubmitContexts(contexts);
  return contextText.length === 0 ? message : `${message}\n\n${contextText}`;
}

function emitUserPromptSubmitHookThrown(
  session: Session,
  error: unknown,
  index: number,
): void {
  session.emit({
    id: session.nextInternalSubId(),
    msg: {
      type: "warning",
      payload: {
        cause: "user_prompt_submit_hook_threw",
        message: `UserPromptSubmit hook ${index} threw: ${error instanceof Error ? error.message : String(error)}`,
      },
    },
  });
}

async function collectUserPromptSubmitHookOutcome(params: {
  readonly session: Session;
  readonly prompt: string;
}): Promise<{
  readonly blocked: boolean;
  readonly additionalContexts: readonly string[];
  readonly blockMessage?: string;
}> {
  const permissionMode = params.session.permissionModeRegistry.current().mode;
  const additionalContexts: string[] = [];
  for await (const hookResult of executeUserPromptSubmitHooks(
    params.prompt,
    permissionMode,
    {
      session: params.session,
      services: params.session.services,
      cwd: params.session.sessionConfiguration.cwd ?? process.cwd(),
      abortController: params.session.abortController,
    },
    undefined,
    (error, index) =>
      emitUserPromptSubmitHookThrown(params.session, error, index),
  )) {
    if (hookResult.additionalContexts) {
      additionalContexts.push(...hookResult.additionalContexts);
    }
    if (hookResult.blockingError) {
      const messageWithContext = appendUserPromptSubmitContextsToMessage(
        getUserPromptSubmitHookBlockingMessage(hookResult.blockingError),
        additionalContexts,
      );
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "user_prompt_submit_hook_blocked",
            message: messageWithContext,
          },
        },
      });
      return {
        blocked: true,
        additionalContexts,
        blockMessage: messageWithContext,
      };
    }
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : "Operation stopped by hook";
      const messageWithContext = appendUserPromptSubmitContextsToMessage(
        message,
        additionalContexts,
      );
      params.session.emit({
        id: params.session.nextInternalSubId(),
        msg: {
          type: "warning",
          payload: {
            cause: "user_prompt_submit_hook_stopped",
            message: messageWithContext,
          },
        },
      });
      return {
        blocked: true,
        additionalContexts,
        blockMessage: messageWithContext,
      };
    }
    const attachment = hookResult.message?.attachment;
    if (
      attachment?.type === "hook_success" &&
      typeof attachment.content === "string" &&
      attachment.content.length > 0
    ) {
      additionalContexts.push(attachment.content);
    }
  }
  return { blocked: false, additionalContexts };
}

/**
 * Canonical user-prompt ingress for every local and daemon-backed turn.
 *
 * UserPromptSubmit hooks run exactly once against the original display text.
 * File mentions expand only after hooks allow the turn, and hook context is
 * appended only after expansion so repository text cannot alter hook input.
 */
export async function prepareUserPromptForTurn(params: {
  readonly session: Session;
  readonly configStore?: Pick<ConfigStore, "current">;
  readonly input: string | readonly LLMContentPart[];
  /** Original user-facing text when transport preprocessing changed input. */
  readonly hookPrompt?: string;
}): Promise<PreparedUserPrompt> {
  const prompt = params.hookPrompt ?? userPromptDisplayText(params.input);
  const hookOutcome = isHookExecutionSuppressed(
    params.session.services.runtimeOptions,
  )
    ? { blocked: false as const, additionalContexts: [] as const }
    : await collectUserPromptSubmitHookOutcome({
        session: params.session,
        prompt,
      });
  if (hookOutcome.blocked) {
    return {
      blocked: true,
      input: params.input,
      ...(hookOutcome.blockMessage !== undefined
        ? { blockMessage: hookOutcome.blockMessage }
        : {}),
    };
  }

  const expanded = await expandPromptFileMentions(params);
  return {
    blocked: false,
    input: appendUserPromptSubmitContexts(
      expanded.input,
      hookOutcome.additionalContexts,
    ),
    displayInput: expanded.displayInput,
  };
}
