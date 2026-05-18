// @ts-nocheck
// Legacy local-JSX adapter: keep old command loaders pointed at the v2
// slash command path so /model cannot fall back to the old picker surface.
import * as React from 'react'

import modelCommand from '../model.js'
import type { CommandResultDisplay } from '../../commands.js'
import { COMMON_HELP_ARGS, COMMON_INFO_ARGS } from '../../constants/xml.js'
import type {
  LocalJSXCommandCall,
  LocalJSXCommandOnDone,
} from '../../types/command.js'

function displayResult(
  onDone: LocalJSXCommandOnDone,
  message: string,
  display: CommandResultDisplay = 'system',
): null {
  onDone(message, { display })
  return null
}

function appStateBridge(context: Record<string, unknown>): Record<string, unknown> | undefined {
  const bridge = typeof context.appState === 'object' && context.appState !== null
    ? context.appState as Record<string, unknown>
    : {}
  const getAppState = typeof context.getAppState === 'function'
    ? { getAppState: context.getAppState }
    : {}
  const setAppState = typeof context.setAppState === 'function'
    ? { setAppState: context.setAppState }
    : {}
  const setToolJSX = typeof context.setToolJSX === 'function'
    ? { setToolJSX: context.setToolJSX }
    : {}
  const merged = { ...bridge, ...getAppState, ...setAppState, ...setToolJSX }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const trimmed = args?.trim() ?? ''
  if (COMMON_HELP_ARGS.includes(trimmed)) {
    return displayResult(
      onDone,
      'Run /model to open the model selection menu, or /model <modelName> to set the model.',
    )
  }

  const record = context as unknown as Record<string, unknown>
  const session = record.session
  if (typeof session !== 'object' || session === null) {
    return displayResult(
      onDone,
      '/model requires a live AgenC session. Use the runtime slash command path.',
    )
  }

  const result = await modelCommand.execute({
    session: session as never,
    argsRaw: COMMON_INFO_ARGS.includes(trimmed) ? '' : trimmed,
    cwd: typeof record.cwd === 'string' ? record.cwd : process.cwd(),
    home: typeof record.home === 'string' ? record.home : process.env.HOME ?? '',
    ...(record.configStore ? { configStore: record.configStore as never } : {}),
    ...(appStateBridge(record) ? { appState: appStateBridge(record) as never } : {}),
  })

  switch (result.kind) {
    case 'text':
      return displayResult(onDone, result.text)
    case 'error':
      return displayResult(onDone, result.message, 'system')
    case 'skip':
      return null
    case 'compact':
      return displayResult(onDone, result.text)
    case 'exit':
      return displayResult(onDone, `Exit requested with code ${result.code}.`)
    case 'prompt':
      return displayResult(onDone, result.prompt)
  }
}

export default { call }
