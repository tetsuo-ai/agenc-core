/**
 * Startup profiling utility for measuring and reporting time spent in various
 * initialization phases.
 *
 * Enable with AGENC_PROFILE_STARTUP=1 for a local report with memory snapshots.
 *
 * Uses Node.js built-in performance hooks API for standard timing measurement.
 */

import { dirname, join } from 'path'
import { getSessionId } from 'src/bootstrap/state.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getAgenCConfigHomeDir, isEnvTruthy } from './envUtils.js'
import { getFsImplementation } from './fsOperations.js'
import { formatMs, formatTimelineLine, getPerformance } from './profilerBase.js'
import { writeFileSync_DEPRECATED } from './slowOperations.js'

// Module-level state - decided once at module load
// eslint-disable-next-line custom-rules/no-process-env-top-level
const DETAILED_PROFILING = isEnvTruthy(process.env.AGENC_PROFILE_STARTUP)

const SHOULD_PROFILE = DETAILED_PROFILING

// Track memory snapshots separately (perf_hooks doesn't track memory).
// Only used when DETAILED_PROFILING is enabled.
// Stored as an array that appends in the same order as perf.mark() calls, so
// memorySnapshots[i] corresponds to getEntriesByType('mark')[i]. Using a Map
// keyed by checkpoint name is wrong because some checkpoints fire more than
// once (e.g. loadSettingsFromDisk_start fires during init and again after
// plugins reset the settings cache), and the second call would overwrite the
// first's memory snapshot.
const memorySnapshots: NodeJS.MemoryUsage[] = []

// Record initial checkpoint if profiling is enabled
if (SHOULD_PROFILE) {
  // eslint-disable-next-line custom-rules/no-top-level-side-effects
  profileCheckpoint('profiler_initialized')
}

/**
 * Record a checkpoint with the given name
 */
export function profileCheckpoint(name: string): void {
  if (!SHOULD_PROFILE) return

  const perf = getPerformance()
  perf.mark(name)

  // Only capture memory when detailed profiling enabled (env var)
  if (DETAILED_PROFILING) {
    memorySnapshots.push(process.memoryUsage())
  }
}

/**
 * Get a formatted report of all checkpoints
 * Only available when DETAILED_PROFILING is enabled
 */
function getReport(): string {
  if (!DETAILED_PROFILING) {
    return 'Startup profiling not enabled'
  }

  const perf = getPerformance()
  const marks = perf.getEntriesByType('mark')
  if (marks.length === 0) {
    return 'No profiling checkpoints recorded'
  }

  const lines: string[] = []
  lines.push('='.repeat(80))
  lines.push('STARTUP PROFILING REPORT')
  lines.push('='.repeat(80))
  lines.push('')

  let prevTime = 0
  for (const [i, mark] of marks.entries()) {
    lines.push(
      formatTimelineLine(
        mark.startTime,
        mark.startTime - prevTime,
        mark.name,
        memorySnapshots[i],
        8,
        7,
      ),
    )
    prevTime = mark.startTime
  }

  const lastMark = marks[marks.length - 1]
  lines.push('')
  lines.push(`Total startup time: ${formatMs(lastMark?.startTime ?? 0)}ms`)
  lines.push('='.repeat(80))

  return lines.join('\n')
}

let reported = false

export function profileReport(): void {
  if (reported) return
  reported = true

  // Output detailed report if AGENC_PROFILE_STARTUP=1
  if (DETAILED_PROFILING) {
    // Write to file
    const path = getStartupPerfLogPath()
    const dir = dirname(path)
    const fs = getFsImplementation()
    fs.mkdirSync(dir)
    writeFileSync_DEPRECATED(path, getReport(), {
      encoding: 'utf8',
      flush: true,
    })

    logForDebugging('Startup profiling report:')
    logForDebugging(getReport())
  }
}

export function isDetailedProfilingEnabled(): boolean {
  return DETAILED_PROFILING
}

export function getStartupPerfLogPath(): string {
  return join(getAgenCConfigHomeDir(), 'startup-perf', `${getSessionId()}.txt`)
}
