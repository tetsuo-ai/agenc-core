import { redactSecrets } from '../secrets/sanitizer.js'
import { attachErrorLogSink } from '../utils/log.js'

/** Connect startup diagnostics to the daemon's bounded log or inherited stderr. */
export function installAgenCDaemonErrorLogSink(options: {
  readonly path: string
  readonly write: (line: string) => void
  readonly writeDebug?: (line: string) => void
}): () => void {
  const line = (level: 'error' | 'debug', message: string, server?: string) =>
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      ...(server === undefined ? {} : { server: redactSecrets(server) }),
      message: redactSecrets(message),
    }) + '\n'
  return attachErrorLogSink({
    logError: error => options.write(line('error', error.stack || error.message)),
    logMCPError: (server, error) => options.write(line('error', String(error), server)),
    logMCPDebug: (server, message) => (options.writeDebug ?? options.write)(line('debug', message, server)),
    getErrorsPath: () => options.path,
    getMCPLogsPath: () => options.path,
  })
}
