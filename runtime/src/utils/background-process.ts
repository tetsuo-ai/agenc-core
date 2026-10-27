import spawn from 'cross-spawn'
import { childProcessAbortError } from './child-signal.js'
import { captureProcessTreeDescendants, signalProcessTree, terminateProcessTreeAndReport } from './supervisedProcess.js'

type Result = { stdout: string; stderr: string; code: number; error?: string }

/** Runtime maintenance never inherits the user's terminal or returns with live descendants. */
export function execBackgroundProcess(
  file: string,
  args: string[],
  options: {
    cwd?: string
    env?: NodeJS.ProcessEnv
    argv0?: string
    timeoutMs: number
    maxBuffer: number
    preserveOutput: boolean
    signal?: AbortSignal
  },
): Promise<Result> {
  if (options.signal?.aborted) {
    return Promise.resolve({ stdout: '', stderr: '', code: 1, error: childProcessAbortError().message })
  }
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      argv0: options.argv0,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let bytes = 0
    let settling = false
    let timeout: ReturnType<typeof setTimeout> | undefined
    const onParentExit = (): void => signalProcessTree(child, 'SIGKILL')
    process.once('exit', onParentExit)

    const finish = async (code: number, error?: string): Promise<void> => {
      if (settling) return
      settling = true
      if (timeout !== undefined) clearTimeout(timeout)
      options.signal?.removeEventListener('abort', onAbort)
      try {
        // The existing supervisor validates ownership and escalates TERM to
        // KILL, including descendants that ignore TERM or keep output pipes open.
        await terminateProcessTreeAndReport(child, {
          terminateGraceMs: 200,
          killGraceMs: 1500,
          label: 'background maintenance',
        })
      } catch (cleanupError) {
        code = 1
        error = cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
      }
      process.removeListener('exit', onParentExit)
      resolve({
        stdout: code === 0 || options.preserveOutput ? stdout : '',
        stderr: code === 0 || options.preserveOutput ? stderr : '',
        code,
        ...(error === undefined ? {} : { error }),
      })
    }
    function onAbort(): void {
      void finish(1, childProcessAbortError(options.signal?.reason).message)
    }
    const append = (chunk: Buffer | string, stream: 'stdout' | 'stderr'): void => {
      if (settling) return
      const value = chunk.toString()
      bytes += Buffer.byteLength(value)
      if (bytes > options.maxBuffer) {
        void finish(1, 'maxBuffer exceeded')
      } else if (stream === 'stdout') {
        stdout += value
      } else {
        stderr += value
      }
    }
    child.once('spawn', () => captureProcessTreeDescendants(child))
    child.stdout?.on('data', chunk => append(chunk, 'stdout'))
    child.stderr?.on('data', chunk => append(chunk, 'stderr'))
    child.once('error', error => { void finish(1, error.message) })
    child.once('close', (code, signal) => {
      void finish(code ?? 1, code === 0 ? undefined : signal ?? String(code))
    })
    if (options.timeoutMs > 0) {
      timeout = setTimeout(() => { void finish(1, `Command timed out after ${options.timeoutMs}ms`) }, options.timeoutMs)
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (options.signal?.aborted) onAbort()
  })
}
