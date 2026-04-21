/**
 * Vendored minimal debug shim. The upstream `logForDebugging` depends on a
 * large tree of session/config/telemetry state; the Ink core only needs a
 * best-effort tracer. We honour DEBUG / NODE_ENV but otherwise no-op unless
 * the user opts in with AGENC_INK_DEBUG.
 */

import { isEnvTruthy } from './envUtils.js'

export type DebugLogLevel = 'verbose' | 'debug' | 'info' | 'warn' | 'error'

const LEVEL_ORDER: Record<DebugLogLevel, number> = {
  verbose: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
}

function enabledLevel(): DebugLogLevel {
  const raw = process.env.AGENC_INK_DEBUG_LEVEL?.toLowerCase().trim()
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as DebugLogLevel
  }
  return 'debug'
}

function isInkDebugEnabled(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_INK_DEBUG) ||
    isEnvTruthy(process.env.DEBUG_INK)
  )
}

export function logForDebugging(
  message: string,
  { level }: { level: DebugLogLevel } = { level: 'debug' },
): void {
  if (!isInkDebugEnabled()) return
  if (LEVEL_ORDER[level] < LEVEL_ORDER[enabledLevel()]) return
  const timestamp = new Date().toISOString()
  const output = `${timestamp} [${level.toUpperCase()}] ${message.trim()}\n`
  process.stderr.write(output)
}
