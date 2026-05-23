import { oscColor, type TerminalQuerier } from '../tui/ink/terminal-querier.js'
import {
  setCachedSystemTheme,
  themeFromOscColor,
  type SystemTheme,
} from './systemTheme.js'
import { logError } from './log.js'

const OSC_BACKGROUND_COLOR = 11
const POLL_INTERVAL_MS = 2_000

export function watchSystemTheme(
  querier: TerminalQuerier,
  onThemeChange: (theme: SystemTheme) => void,
): () => void {
  let cancelled = false
  let inFlight = false

  const poll = async (): Promise<void> => {
    if (cancelled || inFlight) return
    inFlight = true
    try {
      const responsePromise = querier.send(oscColor(OSC_BACKGROUND_COLOR))
      void responsePromise.catch(() => undefined)
      await querier.flush()
      const response = await responsePromise
      if (cancelled || !response) return
      const theme = themeFromOscColor(response.data)
      if (!theme) return
      setCachedSystemTheme(theme)
      onThemeChange(theme)
    } catch (error) {
      logError(error)
    } finally {
      inFlight = false
    }
  }

  void poll()
  const timer = setInterval(() => {
    void poll()
  }, POLL_INTERVAL_MS)

  return () => {
    cancelled = true
    clearInterval(timer)
  }
}
