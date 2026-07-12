// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import type {
  Base64ImageSource,
  ContentBlockParam,
  ImageBlockParam,
} from '@anthropic-ai/sdk/resources/messages.mjs'
import { randomUUID } from 'crypto'
import type { QuerySource } from '../../constants/querySource.js'
import { getContentText } from '../../utils/messages.js'
import {
  findCommand,
  getCommandName,
  isBridgeSafeCommand,
  isCommandEnabled,
  type Command,
  type LocalCommandResult,
  type LocalJSXCommandContext,
} from '../../commands.js'
import type { CanUseToolFn } from '../hooks/useCanUseTool.js'
import type { IDESelection } from '../hooks/useIdeSelection.js'
import type { SetToolJSXFn, ToolUseContext } from '../../tools/Tool.js'
import type {
  AssistantMessage,
  AttachmentMessage,
  Message,
  ProgressMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import {
  isValidImagePaste,
  type PromptInputMode,
} from '../../types/textInputTypes.js'
import {
  createAttachmentMessage,
  getAttachmentMessages,
} from '../../utils/attachments.js'
import type { PastedContent } from '../../utils/config.js'
import type { EffortValue } from '../../utils/effort.js'
import { toArray } from '../../utils/generators.js'
import {
  executeUserPromptSubmitHooks,
  getUserPromptSubmitHookBlockingMessage,
} from '../../hooks/user-prompt-submit.js'
import {
  createImageMetadataText,
  maybeResizeAndDownsampleImageBlock,
} from '../../utils/imageResizer.js'
import { storeImages } from '../../utils/imageStore.js'
import {
  createCommandInputMessage,
  createSyntheticUserCaveatMessage,
  createSystemMessage,
  createUserMessage,
  prepareUserContent,
} from '../../utils/messages.js'
import {
  COMMAND_ARGS_TAG,
  COMMAND_MESSAGE_TAG,
  COMMAND_NAME_TAG,
} from '../../constants/xml.js'
import { escapeXml } from '../../utils/xml.js'
import { queryCheckpoint } from '../../utils/queryProfiler.js'
import { parseSlashCommand } from '../slash/slash-command-parsing.js'
import { addInvokedSkill, getSessionId } from '../../bootstrap/state.js'
import { parseToolListFromCLI } from '../../utils/permissions/permissionSetup.js'
import { registerSkillHooks } from '../../utils/hooks/registerSkillHooks.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  finalizeVimInputForRouting,
  processTextPrompt,
  type VimRoutingState,
} from './processTextPrompt.js'
export type PromptInputContext = ToolUseContext & LocalJSXCommandContext

export type PromptInputResult = {
  messages: (
    | UserMessage
    | AssistantMessage
    | AttachmentMessage
    | SystemMessage
    | ProgressMessage
  )[]
  shouldQuery: boolean
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
  // Output text for non-interactive mode (e.g., forked commands)
  // When set, this is used as the result in -p mode instead of empty string
  resultText?: string
  // When set, prefills or submits the next input after command completes
  // Used by /discover to chain into the selected feature's command
  nextInput?: string
  submitNextInput?: boolean
}

export async function processPromptInput({
  input,
  preExpansionInput,
  mode,
  setToolJSX,
  context,
  pastedContents,
  ideSelection,
  messages,
  setUserInputOnProcessing,
  uuid,
  isAlreadyProcessing,
  querySource,
  canUseTool,
  skipSlashCommands,
  bridgeOrigin,
  isMeta,
  skipAttachments,
  vimRoutingState,
}: {
  input: string | Array<ContentBlockParam>
  /**
   * Input before [Pasted text #N] expansion. Falls back to the string
   * `input` when unset.
   */
  preExpansionInput?: string
  mode: PromptInputMode
  setToolJSX: SetToolJSXFn
  context: PromptInputContext
  pastedContents?: Record<number, PastedContent>
  ideSelection?: IDESelection
  messages?: Message[]
  setUserInputOnProcessing?: (prompt?: string) => void
  uuid?: string
  isAlreadyProcessing?: boolean
  querySource?: QuerySource
  canUseTool?: CanUseToolFn
  /**
   * When true, input starting with `/` is treated as plain text.
   * Used for remotely-received messages (bridge/CCR) that should not
   * trigger local slash commands or skills.
   */
  skipSlashCommands?: boolean
  /**
   * When true, slash commands matching isBridgeSafeCommand() execute even
   * though skipSlashCommands is set. See QueuedCommand.bridgeOrigin.
   */
  bridgeOrigin?: boolean
  /**
   * When true, the resulting UserMessage gets `isMeta: true` (user-hidden,
   * model-visible). Propagated from `QueuedCommand.isMeta` for queued
   * system-generated prompts.
   */
  isMeta?: boolean
  skipAttachments?: boolean
  vimRoutingState?: VimRoutingState
}): Promise<PromptInputResult> {
  const routedInput =
    typeof input === 'string'
      ? finalizeVimInputForRouting(input, vimRoutingState)
      : input
  const inputString = typeof routedInput === 'string' ? routedInput : null
  // Immediately show the user input prompt while we are still processing the input.
  // Skip for isMeta (system-generated prompts like scheduled tasks) — those
  // should run invisibly.
  if (mode === 'prompt' && inputString !== null && !isMeta) {
    setUserInputOnProcessing?.(inputString)
  }

  queryCheckpoint('query_process_prompt_input_base_start')

  const appState = context.getAppState()

  const result = await processPromptInputBase(
    routedInput,
    mode,
    setToolJSX,
    context,
    pastedContents,
    ideSelection,
    messages,
    uuid,
    isAlreadyProcessing,
    querySource,
    canUseTool,
    appState.toolPermissionContext.mode,
    skipSlashCommands,
    bridgeOrigin,
    isMeta,
    skipAttachments,
    preExpansionInput,
  )
  queryCheckpoint('query_process_prompt_input_base_end')

  if (!result.shouldQuery) {
    return result
  }

  // Execute UserPromptSubmit hooks and handle blocking
  queryCheckpoint('query_hooks_start')
  const inputMessage = getContentText(routedInput) || ''
  const blockingContextMessages: AttachmentMessage[] = []

  const appendUserPromptSubmitContexts = (
    contexts: readonly string[] | undefined,
  ) => {
    if (!contexts || contexts.length === 0) return
    const message = createAttachmentMessage({
      type: 'hook_additional_context',
      content: contexts.map(applyTruncation),
      hookName: 'UserPromptSubmit',
      toolUseID: `hook-${randomUUID()}`,
      hookEvent: 'UserPromptSubmit',
    })
    result.messages.push(message)
    blockingContextMessages.push(message)
  }

  for await (const hookResult of executeUserPromptSubmitHooks(
    inputMessage,
    appState.toolPermissionContext.mode,
    context,
    context.requestPrompt,
    (err, idx) => emitUserPromptSubmitHookWarning(context, err, idx),
  )) {
    // We only care about the result
    if (hookResult.message?.type === 'progress') {
      continue
    }

    appendUserPromptSubmitContexts(hookResult.additionalContexts)

    // Return only a system-level error message, erasing the original user input
    if (hookResult.blockingError) {
      const blockingMessage = getUserPromptSubmitHookBlockingMessage(
        hookResult.blockingError,
      )
      return {
        messages: [
          ...blockingContextMessages,
          // Follow-up: Make this an attachment message
          createSystemMessage(
            `${blockingMessage}\n\nOriginal prompt: ${inputMessage}`,
            'warning',
          ),
        ],
        shouldQuery: false,
        allowedTools: result.allowedTools,
      }
    }

    // If preventContinuation is set, stop processing but keep the original
    // prompt in context.
    if (hookResult.preventContinuation) {
      const message = hookResult.stopReason
        ? `Operation stopped by hook: ${hookResult.stopReason}`
        : 'Operation stopped by hook'
      result.messages.push(
        createUserMessage({
          content: message,
        }),
      )
      result.shouldQuery = false
      return result
    }

    // Follow-up: Clean this up
    if (hookResult.message) {
      switch (hookResult.message.attachment.type) {
        case 'hook_success':
          if (!hookResult.message.attachment.content) {
            // Skip if there is no content
            break
          }
          result.messages.push({
            ...hookResult.message,
            attachment: {
              ...hookResult.message.attachment,
              content: applyTruncation(hookResult.message.attachment.content),
            },
          })
          break
        default:
          result.messages.push(hookResult.message)
          break
      }
    }
  }
  queryCheckpoint('query_hooks_end')

  // Happy path: onQuery will clear userInputOnProcessing via startTransition
  // so it resolves in the same frame as deferredMessages (no flicker gap).
  // Error paths are handled by handlePromptSubmit's finally block.
  return result
}

function localCommandResultToPromptInputResult(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  uuid: string | undefined,
  result: LocalCommandResult,
): PromptInputResult {
  if (result.type === 'skip') {
    return { messages: [], shouldQuery: false }
  }

  const text =
    result.type === 'compact' ? result.displayText ?? '' : result.value
  if (!text) {
    return { messages: [], shouldQuery: false }
  }

  return {
    messages: [
      createSyntheticUserCaveatMessage(),
      createUserMessage({
        content: prepareUserContent({ inputString, precedingInputBlocks }),
        uuid,
      }),
      ...attachmentMessages,
      createUserMessage({
        content: `<local-command-stdout>${escapeXml(text)}</local-command-stdout>`,
      }),
    ],
    shouldQuery: false,
    resultText: text,
  }
}

export function parseDollarSkillCommand(input: string): {
  commandName: string
  args: string
} | null {
  const lines = input.split('\n')
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) return null
  }
  let first = lines[0]!
  if (first.endsWith('\r')) first = first.slice(0, -1)
  first = first.trim()
  const match = first.match(/^\$([A-Za-z.][A-Za-z0-9_.:-]*)(?:\s+(.*))?$/)
  if (!match) return null
  return {
    commandName: match[1]!,
    args: (match[2] ?? '').trim(),
  }
}

export function formatDollarSkillInputTags(commandName: string, args: string): string {
  const escapedCommandName = escapeXml(commandName)
  const escapedArgs = escapeXml(args)
  return `<${COMMAND_NAME_TAG}>$${escapedCommandName}</${COMMAND_NAME_TAG}>
            <${COMMAND_MESSAGE_TAG}>${escapedCommandName}</${COMMAND_MESSAGE_TAG}>
            <${COMMAND_ARGS_TAG}>${escapedArgs}</${COMMAND_ARGS_TAG}>
            <skill-format>true</skill-format>`
}

export function isDollarSkillCommand(command: unknown): command is Extract<Command, { type: 'prompt' }> {
  return !!command &&
    typeof command === 'object' &&
    (command as Command).type === 'prompt' &&
    ((command as Command).loadedFrom === 'skills' ||
      (command as Command).loadedFrom === 'plugin' ||
      (command as Command).loadedFrom === 'mcp')
}

export async function loadDollarSkillCommandForTurn(
  parsed: { commandName: string; args: string },
  command: Extract<Command, { type: 'prompt' }>,
  context: PromptInputContext,
): Promise<{
  metadata: string
  blocks: ContentBlockParam[]
  skillContent: string
  allowedTools?: string[]
  model?: string
  effort?: EffortValue
}> {
  const blocks = await command.getPromptForCommand(parsed.args, context)
  const skillContent = blocks
    .filter((block): block is Extract<ContentBlockParam, { type: 'text' }> => block.type === 'text')
    .map(block => block.text)
    .join('\n\n')
  const skillPath = command.skillRoot
    ? `${command.skillRoot}:${command.name}`
    : command.source
      ? `${command.source}:${command.name}`
      : command.name

  addInvokedSkill(command.name, skillPath, skillContent, null)

  const hooksAllowedForThisSkill =
    !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source)
  if (command.hooks && hooksAllowedForThisSkill) {
    registerSkillHooks(
      context.setAppState,
      getSessionId(),
      command.hooks,
      command.name,
      command.skillRoot,
    )
  }

  return {
    metadata: formatDollarSkillInputTags(command.name, parsed.args),
    blocks,
    skillContent,
    allowedTools: parseToolListFromCLI(command.allowedTools ?? []),
    model: command.model,
    effort: command.effort,
  }
}

async function processDollarSkillInput(
  parsed: { commandName: string; args: string },
  command: Extract<Command, { type: 'prompt' }>,
  context: PromptInputContext,
  uuid?: string,
  attachmentMessages: AttachmentMessage[] = [],
): Promise<PromptInputResult> {
  const loaded = await loadDollarSkillCommandForTurn(parsed, command, context)

  return {
    messages: [
      createUserMessage({
        content: loaded.metadata,
        uuid,
      }),
      ...attachmentMessages,
      createUserMessage({
        content: loaded.blocks,
        isMeta: true,
      }),
    ],
    shouldQuery: true,
    allowedTools: loaded.allowedTools,
    model: loaded.model,
    effort: loaded.effort,
    resultText: `Loaded $${command.name}`,
  }
}

async function processRegistrySlashInput(
  inputString: string,
  precedingInputBlocks: ContentBlockParam[],
  attachmentMessages: AttachmentMessage[],
  context: PromptInputContext,
  uuid?: string,
): Promise<PromptInputResult> {
  const parsed = parseSlashCommand(inputString)
  if (!parsed) {
    return localCommandResultToPromptInputResult(
      inputString,
      precedingInputBlocks,
      attachmentMessages,
      uuid,
      { type: 'text', value: 'Commands are in the form `/command [args]`' },
    )
  }
  const command = findCommand(parsed.commandName, context.options.commands)

  if (!command || (command.type !== 'local' && command.type !== 'prompt')) {
    return localCommandResultToPromptInputResult(
      inputString,
      precedingInputBlocks,
      attachmentMessages,
      uuid,
      { type: 'text', value: `Unknown command: /${parsed.commandName}` },
    )
  }

  if (command.userInvocable === false || !isCommandEnabled(command)) {
    return localCommandResultToPromptInputResult(
      inputString,
      precedingInputBlocks,
      attachmentMessages,
      uuid,
      { type: 'text', value: `/${getCommandName(command)} is not available` },
    )
  }

  // Prompt commands (markdown rails under a commands dir, skills, plugins)
  // invoked via `/` expand into the turn exactly like `$skill`. Slash
  // execution had been narrowed to `type: 'local'`, which left every
  // `.agenc/commands/*.md` rail and skill visible in the palette but
  // non-invocable from the composer ("Unknown command"). Routing them
  // through the shared prompt loader restores `/command` expansion without
  // widening tool/hook scope beyond what `$` already grants.
  if (command.type === 'prompt') {
    return processDollarSkillInput(
      parsed,
      command,
      context,
      uuid,
      attachmentMessages,
    )
  }

  const local = await command.load()
  const result = await local.call(parsed.args, context)
  return localCommandResultToPromptInputResult(
    inputString,
    precedingInputBlocks,
    attachmentMessages,
    uuid,
    result,
  )
}

function emitUserPromptSubmitHookWarning(
  context: PromptInputContext,
  err: unknown,
  idx: number,
): void {
  const session = (context as { session?: unknown }).session as
    | {
        emit?: (event: unknown) => void
        nextInternalSubId?: () => string
      }
    | undefined
  if (typeof session?.emit !== 'function') return
  const message = err instanceof Error ? err.message : String(err)
  session.emit({
    id:
      typeof session.nextInternalSubId === 'function'
        ? session.nextInternalSubId()
        : `user-prompt-submit-hook-${idx}`,
    msg: {
      type: 'warning',
      payload: {
        cause: 'user_prompt_submit_hook_threw',
        message: `UserPromptSubmit hook ${idx} failed: ${message}`,
      },
    },
  })
}

const MAX_HOOK_OUTPUT_LENGTH = 10000

function applyTruncation(content: string): string {
  if (content.length > MAX_HOOK_OUTPUT_LENGTH) {
    return `${content.substring(0, MAX_HOOK_OUTPUT_LENGTH)}… [output truncated - exceeded ${MAX_HOOK_OUTPUT_LENGTH} characters]`
  }
  return content
}

async function processPromptInputBase(
  input: string | Array<ContentBlockParam>,
  mode: PromptInputMode,
  setToolJSX: SetToolJSXFn,
  context: PromptInputContext,
  pastedContents?: Record<number, PastedContent>,
  ideSelection?: IDESelection,
  messages?: Message[],
  uuid?: string,
  isAlreadyProcessing?: boolean,
  querySource?: QuerySource,
  canUseTool?: CanUseToolFn,
  permissionMode?: PermissionMode,
  skipSlashCommands?: boolean,
  bridgeOrigin?: boolean,
  isMeta?: boolean,
  skipAttachments?: boolean,
  preExpansionInput?: string,
): Promise<PromptInputResult> {
  let inputString: string | null = null
  let precedingInputBlocks: ContentBlockParam[] = []

  // Collect image metadata texts for isMeta message
  const imageMetadataTexts: string[] = []

  // Normalized view of `input` with image blocks resized. For string input
  // this is just `input`; for array input it's the processed blocks. We pass
  // this (not raw `input`) to processTextPrompt so resized/normalized image
  // blocks actually reach the API — otherwise the resize work above is
  // discarded for the regular prompt path. Also normalizes bridge inputs
  // where iOS may send `mediaType` instead of `media_type` (mobile-apps#5825).
  let normalizedInput: string | ContentBlockParam[] = input

  if (typeof input === 'string') {
    inputString = input
  } else if (input.length > 0) {
    queryCheckpoint('query_image_processing_start')
    const processedBlocks: ContentBlockParam[] = []
    for (const block of input) {
      if (block.type === 'image') {
        const resized = await maybeResizeAndDownsampleImageBlock(block)
        // Collect image metadata for isMeta message
        if (resized.dimensions) {
          const metadataText = createImageMetadataText(resized.dimensions)
          if (metadataText) {
            imageMetadataTexts.push(metadataText)
          }
        }
        processedBlocks.push(resized.block)
      } else {
        processedBlocks.push(block)
      }
    }
    normalizedInput = processedBlocks
    queryCheckpoint('query_image_processing_end')
    // Extract the input string from the last content block if it is text,
    // and keep track of the preceding content blocks
    const lastBlock = processedBlocks[processedBlocks.length - 1]
    if (lastBlock?.type === 'text') {
      inputString = lastBlock.text
      precedingInputBlocks = processedBlocks.slice(0, -1)
    } else {
      precedingInputBlocks = processedBlocks
    }
  }

  if (inputString === null && mode !== 'prompt') {
    throw new Error(`Mode: ${mode} requires a string input.`)
  }

  // Extract and convert image content to content blocks early
  // Keep track of IDs in order for message storage
  const imageContents = pastedContents
    ? Object.values(pastedContents).filter(isValidImagePaste)
    : []
  const imagePasteIds = imageContents.map(img => img.id)

  // Store images to disk so AgenC can reference the path in context
  // (for manipulation with CLI tools, uploading to PRs, etc.)
  const storedImagePaths = pastedContents
    ? await storeImages(pastedContents)
    : new Map<number, string>()

  // Resize pasted images to ensure they fit within API limits (parallel processing)
  queryCheckpoint('query_pasted_image_processing_start')
  const imageProcessingResults = await Promise.all(
    imageContents.map(async pastedImage => {
      const imageBlock: ImageBlockParam = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: (pastedImage.mediaType ||
            'image/png') as Base64ImageSource['media_type'],
          data: pastedImage.content,
        },
      }
      const resized = await maybeResizeAndDownsampleImageBlock(imageBlock)
      return {
        resized,
        originalDimensions: pastedImage.dimensions,
        sourcePath:
          pastedImage.sourcePath ?? storedImagePaths.get(pastedImage.id),
      }
    }),
  )
  // Collect results preserving order
  const imageContentBlocks: ContentBlockParam[] = []
  for (const {
    resized,
    originalDimensions,
    sourcePath,
  } of imageProcessingResults) {
    // Collect image metadata for isMeta message (prefer resized dimensions)
    if (resized.dimensions) {
      const metadataText = createImageMetadataText(
        resized.dimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (originalDimensions) {
      // Fall back to original dimensions if resize didn't provide them
      const metadataText = createImageMetadataText(
        originalDimensions,
        sourcePath,
      )
      if (metadataText) {
        imageMetadataTexts.push(metadataText)
      }
    } else if (sourcePath) {
      // If we have a source path but no dimensions, still add source info
      imageMetadataTexts.push(`[Image source: ${sourcePath}]`)
    }
    imageContentBlocks.push(resized.block)
  }
  queryCheckpoint('query_pasted_image_processing_end')

  // Bridge-safe slash command override: mobile/web clients set bridgeOrigin
  // with skipSlashCommands still true (defense-in-depth against exit words and
  // immediate-command fast paths). Resolve the command here — if it passes
  // isBridgeSafeCommand, clear the skip so the gate below opens. If it's a
  // known-but-unsafe command (local-jsx UI or terminal-only), short-circuit
  // with a helpful message rather than letting the model see raw "/config".
  let effectiveSkipSlash = skipSlashCommands
  if (bridgeOrigin && inputString !== null && inputString.startsWith('/')) {
    const parsed = parseSlashCommand(inputString)
    const cmd = parsed
      ? findCommand(parsed.commandName, context.options.commands)
      : undefined
    if (cmd) {
      if (isBridgeSafeCommand(cmd)) {
        effectiveSkipSlash = false
      } else {
        const msg = `/${getCommandName(cmd)} isn't available over Remote Control.`
        return {
          messages: [
            createUserMessage({ content: inputString, uuid }),
            createCommandInputMessage(
              `<local-command-stdout>${msg}</local-command-stdout>`,
            ),
          ],
          shouldQuery: false,
          resultText: msg,
        }
      }
    }
    // Unknown /foo or unparseable — fall through to plain text, same as
    // pre-#19134. A mobile user typing "/shrug" shouldn't see "Unknown skill".
  }

  void preExpansionInput
  void imageContentBlocks
  void isAlreadyProcessing
  void canUseTool

  // For slash commands, attachments are not extracted. Slash execution is
  // limited to the minimal local registry and no longer expands skills.
  const shouldExtractAttachments =
    !skipAttachments &&
    inputString !== null &&
    (mode !== 'prompt' || effectiveSkipSlash || !inputString.startsWith('/'))

  queryCheckpoint('query_attachment_loading_start')
  const attachmentMessages = shouldExtractAttachments
    ? await toArray(
        getAttachmentMessages(
          inputString,
          context,
          ideSelection ?? null,
          [], // queuedCommands - handled by query.ts for mid-turn attachments
          messages,
          querySource,
        ),
      )
    : []
  queryCheckpoint('query_attachment_loading_end')

  // Bash commands. The composer ships `mode: 'bash'` whenever the user
  // pressed `!` to enter bash mode. PromptInput today calls
  // processBashCommand directly (round-2 MD-NEW4), so in practice this
  // branch fires only from the legacy handlePromptSubmit /
  // queue-processor path. The check is kept so any caller that reaches
  // this function with bash mode still gets correct routing.
  if (inputString !== null && mode === 'bash') {
    const { processBashCommand } = await import('./processBashCommand.js')
    return addImageMetadataMessage(
      await processBashCommand(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        setToolJSX,
      ),
      imageMetadataTexts,
    )
  }

  // Skill commands. User-facing skills use `$skill [args]`; slash stays
  // reserved for local commands and `@` stays reserved for mentions.
  if (
    inputString !== null &&
    mode === 'prompt' &&
    !effectiveSkipSlash &&
    inputString.trim().startsWith('$')
  ) {
    const parsedSkill = parseDollarSkillCommand(inputString)
    if (parsedSkill) {
      const command = findCommand(parsedSkill.commandName, context.options.commands)
      if (isDollarSkillCommand(command)) {
        return addImageMetadataMessage(
          await processDollarSkillInput(
            parsedSkill,
            command,
            context,
            uuid,
            attachmentMessages,
          ),
          imageMetadataTexts,
        )
      }
      if (command?.type === 'local') {
        return localCommandResultToPromptInputResult(
          inputString,
          precedingInputBlocks,
          attachmentMessages,
          uuid,
          { type: 'text', value: `Use /${parsedSkill.commandName} for commands. Skills use $skill-name.` },
        )
      }
      return localCommandResultToPromptInputResult(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        uuid,
        {
          type: 'text',
          value: `Unknown skill: $${parsedSkill.commandName}\nUse /skills to list skills or /skills new ${parsedSkill.commandName} to create one.`,
        },
      )
    }
  }

  // Slash commands
  // Skip for remote bridge messages — input from CCR clients is plain text
  if (
    inputString !== null &&
    !effectiveSkipSlash &&
    inputString.startsWith('/')
  ) {
    return addImageMetadataMessage(
      await processRegistrySlashInput(
        inputString,
        precedingInputBlocks,
        attachmentMessages,
        context,
        uuid,
      ),
      imageMetadataTexts,
    )
  }

  // Regular user prompt. For string input, normalizedInput is already the
  // vim-finalized value passed into this base processor by processPromptInput.
  const promptInput = normalizedInput
  return addImageMetadataMessage(
    processTextPrompt(
      promptInput,
      imageContentBlocks,
      imagePasteIds,
      attachmentMessages,
      uuid,
      permissionMode,
      isMeta,
    ),
    imageMetadataTexts,
  )
}

// Adds image metadata texts as isMeta message to result
function addImageMetadataMessage(
  result: PromptInputResult,
  imageMetadataTexts: string[],
): PromptInputResult {
  if (imageMetadataTexts.length > 0) {
    result.messages.push(
      createUserMessage({
        content: imageMetadataTexts.map(text => ({ type: 'text', text })),
        isMeta: true,
      }),
    )
  }
  return result
}
