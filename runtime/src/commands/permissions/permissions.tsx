// @ts-nocheck
// Legacy local-JSX adapter: keep old command loaders pointed at the v2
// slash command path so /permissions cannot fall back to old rule dialogs.
import permissionsCommand from '../permissions.js'
import type { CommandResultDisplay } from '../../commands.js'
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
  const setToolJSX = typeof context.setToolJSX === 'function'
    ? { setToolJSX: context.setToolJSX }
    : {}
  const merged = { ...bridge, ...setToolJSX }
  return Object.keys(merged).length > 0 ? merged : undefined
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const record = context as unknown as Record<string, unknown>
  const session = record.session
  if (typeof session !== 'object' || session === null) {
    return displayResult(
      onDone,
      '/permissions requires a live AgenC session. Use the runtime slash command path.',
    )
  }

  const result = await permissionsCommand.execute({
    session: session as never,
    argsRaw: args?.trim() ?? '',
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
      return displayResult(onDone, result.content)
  }
}

export default { call }
