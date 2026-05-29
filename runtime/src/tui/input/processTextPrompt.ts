import type { ContentBlockParam } from '@anthropic-ai/sdk/resources'
import { randomUUID } from 'crypto'
import { setPromptId } from '../../bootstrap/state.js'
import type {
  AttachmentMessage,
  SystemMessage,
  UserMessage,
} from '../../types/message.js'
import type { PermissionMode } from '../../types/permissions.js'
import type { VimMode } from '../../types/textInputTypes.js'
import { createUserMessage } from '../../utils/messages.js'
import { TextCursor } from '../../utils/TextCursor.js'
import { transition, type TransitionContext } from '../vim/transitions.js'
import type { CommandState, FindType, RecordedChange } from '../vim/types.js'

export type VimRoutingState = {
  enabled: boolean
  mode: VimMode
  keys: readonly string[]
  cursorOffset?: number
  columns?: number
}

export function finalizeVimInputForRouting(
  input: string,
  vimRoutingState?: VimRoutingState,
): string {
  if (vimRoutingState?.enabled !== true) {
    return input
  }

  let text = input
  let offset = Math.max(
    0,
    Math.min(vimRoutingState.cursorOffset ?? 0, text.length),
  )
  let mode: VimMode = vimRoutingState.mode
  let command: CommandState = { type: 'idle' }
  let register = ''
  let registerIsLinewise = false
  let lastFind: { type: FindType; char: string } | null = null
  const changes: RecordedChange[] = []
  const columns = vimRoutingState.columns ?? 80

  const ctx: TransitionContext = {
    get cursor() {
      return TextCursor.fromText(text, columns, offset)
    },
    get text() {
      return text
    },
    setText: nextText => {
      text = nextText
      offset = Math.min(offset, text.length)
    },
    setOffset: nextOffset => {
      offset = Math.max(0, Math.min(nextOffset, text.length))
    },
    enterInsert: nextOffset => {
      mode = 'INSERT'
      offset = Math.max(0, Math.min(nextOffset, text.length))
    },
    getRegister: () => register,
    setRegister: (content, linewise) => {
      register = content
      registerIsLinewise = linewise
    },
    getLastFind: () => lastFind,
    setLastFind: (type, char) => {
      lastFind = { type, char }
    },
    recordChange: change => {
      changes.push(change)
    },
  }

  for (const key of vimRoutingState.keys) {
    if (mode === 'INSERT') {
      if (key === '\x1b') {
        mode = 'NORMAL'
        command = { type: 'idle' }
        continue
      }
      text = text.slice(0, offset) + key + text.slice(offset)
      offset += key.length
      continue
    }

    const result = transition(command, key, ctx)
    result.execute?.()
    command = result.next ?? { type: 'idle' }
  }

  void registerIsLinewise
  void changes
  return text
}

export function processTextPrompt(
  input: string | Array<ContentBlockParam>,
  imageContentBlocks: ContentBlockParam[],
  imagePasteIds: number[],
  attachmentMessages: AttachmentMessage[],
  uuid?: string,
  permissionMode?: PermissionMode,
  isMeta?: boolean,
  vimRoutingState?: VimRoutingState,
): {
  messages: (UserMessage | AttachmentMessage | SystemMessage)[]
  shouldQuery: boolean
} {
  const routedInput =
    typeof input === 'string'
      ? finalizeVimInputForRouting(input, vimRoutingState)
      : input
  const promptId = randomUUID()
  setPromptId(promptId)

  // If we have pasted images, create a message with image content
  if (imageContentBlocks.length > 0) {
    // Build content: text first, then images below
    const textContent =
      typeof routedInput === 'string'
        ? routedInput.trim()
          ? [{ type: 'text' as const, text: routedInput }]
          : []
        : routedInput
    const userMessage = createUserMessage({
      content: [...textContent, ...imageContentBlocks],
      uuid: uuid,
      imagePasteIds: imagePasteIds.length > 0 ? imagePasteIds : undefined,
      permissionMode,
      isMeta: isMeta || undefined,
    })

    return {
      messages: [userMessage, ...attachmentMessages],
      shouldQuery: true,
    }
  }

  const userMessage = createUserMessage({
    content: routedInput,
    uuid,
    permissionMode,
    isMeta: isMeta || undefined,
  })

  return {
    messages: [userMessage, ...attachmentMessages],
    shouldQuery: true,
  }
}
