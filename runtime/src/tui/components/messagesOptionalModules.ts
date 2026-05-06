import { createRequire } from 'node:module'

type ProactiveModule = {
  isProactiveActive?: () => boolean
}

type SendUserFilePromptModule = {
  SEND_USER_FILE_TOOL_NAME?: string
}

const requireFromHere = createRequire(import.meta.url)
const optionalModuleRoot = '../../'
let proactiveModule: ProactiveModule | null | undefined
let sendUserFilePromptModule: SendUserFilePromptModule | null | undefined

function isMissingOptionalModule(error: unknown, path: string): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as NodeJS.ErrnoException).code
  if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') {
    return false
  }
  return (
    error.message.includes(path) ||
    error.message.includes(`${optionalModuleRoot}${path}`)
  )
}

function loadOptionalModule<T>(path: string): T | null {
  try {
    return requireFromHere(optionalModuleRoot + path) as T
  } catch (error) {
    if (isMissingOptionalModule(error, path)) return null
    throw error
  }
}

function loadProactiveModule(): ProactiveModule | null {
  if (proactiveModule !== undefined) return proactiveModule
  proactiveModule = loadOptionalModule<ProactiveModule>('proactive/index.js')
  return proactiveModule
}

function loadSendUserFilePromptModule(): SendUserFilePromptModule | null {
  if (sendUserFilePromptModule !== undefined) return sendUserFilePromptModule
  sendUserFilePromptModule = loadOptionalModule<SendUserFilePromptModule>(
    'tools/SendUserFileTool/prompt.js',
  )
  return sendUserFilePromptModule
}

export function isMessagesProactiveActive(): boolean {
  return loadProactiveModule()?.isProactiveActive?.() ?? false
}

export function getMessagesSendUserFileToolName(): string | null {
  return loadSendUserFilePromptModule()?.SEND_USER_FILE_TOOL_NAME ?? null
}
