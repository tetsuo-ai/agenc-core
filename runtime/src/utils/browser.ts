import { spawn } from 'node:child_process'

import { execFileNoThrow } from './execFileNoThrow.js'

function validateUrl(url: string): void {
  let parsedUrl: URL

  try {
    parsedUrl = new URL(url)
  } catch (_error) {
    throw new Error(`Invalid URL format: ${url}`)
  }

  // Validate URL protocol for security
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new Error(
      `Invalid URL protocol: must use http:// or https://, got ${parsedUrl.protocol}`,
    )
  }
}

/**
 * Open a file or folder path using the system's default handler.
 * Uses `open` on macOS, `explorer` on Windows, `xdg-open` on Linux.
 */
export async function openPath(path: string): Promise<boolean> {
  try {
    const platform = process.platform
    if (platform === 'win32') {
      const { code } = await execFileNoThrow('explorer', [path])
      return code === 0
    }
    const command = platform === 'darwin' ? 'open' : 'xdg-open'
    const { code } = await execFileNoThrow(command, [path])
    return code === 0
  } catch (_) {
    return false
  }
}

export async function openBrowser(url: string): Promise<boolean> {
  try {
    // Parse and validate the URL
    validateUrl(url)

    const browserEnv = process.env.BROWSER
    const platform = process.platform

    if (platform === 'win32') {
      if (browserEnv) {
        // browsers require shell, else they will treat this as a file:/// handle
        const { code } = await execFileNoThrow(browserEnv, [`"${url}"`])
        return code === 0
      }
      const { code } = await execFileNoThrow(
        'rundll32',
        ['url,OpenURL', url],
        {},
      )
      return code === 0
    } else {
      const command =
        browserEnv || (platform === 'darwin' ? 'open' : 'xdg-open')
      const { code } = await execFileNoThrow(command, [url])
      return code === 0
    }
  } catch (_) {
    return false
  }
}

export async function openLocalBrowser(url: string): Promise<void> {
  const environment = { ...process.env }
  const manualOpening = 'Open the displayed sign-in URL manually.'
  if (
    process.platform === 'linux' &&
    !environment.DISPLAY?.trim() &&
    !environment.WAYLAND_DISPLAY?.trim() &&
    !environment.BROWSER?.trim()
  ) {
    throw new Error(`No graphical browser environment is available. ${manualOpening}`)
  }
  const { command, args } = browserOpenCommand(url)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: environment,
    })
    const timeout = setTimeout(() => {
      reject(new Error(`Browser launcher did not confirm opening within 5 seconds. ${manualOpening}`))
    }, 5_000)
    child.once('error', () => {
      clearTimeout(timeout)
      reject(new Error(`Browser launcher could not start. ${manualOpening}`))
    })
    child.once('spawn', () => {
      child.unref()
    })
    child.once('exit', (code, signal) => {
      clearTimeout(timeout)
      if (code === 0) {
        resolve()
      } else {
        const cause = signal === null ? `exit code ${code}` : `signal ${signal}`
        reject(new Error(`Browser launcher failed with ${cause}. ${manualOpening}`))
      }
    })
  })
}

function browserOpenCommand(url: string): {
  readonly command: string
  readonly args: readonly string[]
} {
  if (process.platform === 'darwin') {
    return { command: 'open', args: [url] }
  }
  if (process.platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] }
  }
  return { command: 'xdg-open', args: [url] }
}
