#!/usr/bin/env node

import { spawn } from 'node:child_process'
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createHermeticLaunchEnv,
  createHermeticRunRoot,
  HERMETIC_DESIGN_INPUT_ENV_VARS,
  HERMETIC_MARKER_ENV_VAR,
  sanitizeHermeticEnv,
} from '../tests/helpers/hermetic-env.mjs'

const runtimeRoot = fileURLToPath(new URL('../', import.meta.url))
const vitestCli = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
)
const networkTripwire = fileURLToPath(
  new URL('../tests/helpers/network-tripwire.cjs', import.meta.url),
)

const args = process.argv.slice(2)
const designIndex = args.indexOf('--design')
const design = designIndex !== -1
if (design) args.splice(designIndex, 1)
if (args.length === 0) args.push('run')

async function run() {
  // The unsandboxed prelauncher owns one disposable run root. Every worker
  // home and the sticky attempt ledger live below it, so cleanup is reliable
  // even when Vitest terminates workers without running their exit hooks.
  const runRoot = createHermeticRunRoot('agv-')
  try {
    const childEnv = createHermeticLaunchEnv(process.env, runRoot, {
      preserve: design ? HERMETIC_DESIGN_INPUT_ENV_VARS : [],
    })
    const coordinatorHome = join(runRoot, 'coordinator-home')
    mkdirSync(coordinatorHome, { mode: 0o700, recursive: true })
    sanitizeHermeticEnv(childEnv, coordinatorHome, {
      preserve: design ? HERMETIC_DESIGN_INPUT_ENV_VARS : [],
    })
    childEnv.AGENC_TEST_HERMETIC_RUN_ROOT = runRoot

    const attemptLedger = join(runRoot, 'network-attempts')
    mkdirSync(attemptLedger, { mode: 0o700, recursive: true })
    childEnv.AGENC_TEST_NETWORK_ATTEMPT_LEDGER = attemptLedger

    // This marker proves setupFiles ran in each Vitest worker; the prelauncher
    // must not stamp it or a removed setupFiles entry would be masked.
    delete childEnv[HERMETIC_MARKER_ENV_VAR]
    delete childEnv.AGENC_TEST_HERMETIC_HOME

    // NODE_EXTRA_CA_CERTS and other launch-time trust inputs were removed above.
    // Replace (do not append to) ambient NODE_OPTIONS so arbitrary --require or
    // --import hooks cannot execute in the hermetic Vitest coordinator. The one
    // reviewed preload guards the coordinator and propagates itself to workers.
    childEnv.NODE_OPTIONS = `--require ${JSON.stringify(networkTripwire)}`

    const child = spawn(process.execPath, [vitestCli, ...args], {
      cwd: runtimeRoot,
      env: childEnv,
      stdio: 'inherit',
    })

    const forwardedSignals = ['SIGINT', 'SIGTERM']
    const signalHandlers = new Map()
    for (const signal of forwardedSignals) {
      const handler = () => child.kill(signal)
      signalHandlers.set(signal, handler)
      process.on(signal, handler)
    }

    let result
    try {
      result = await new Promise((resolve, reject) => {
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
    } finally {
      for (const [signal, handler] of signalHandlers) {
        process.off(signal, handler)
      }
    }

    let exitCode = result.code ?? 1
    let attemptRecords
    try {
      attemptRecords = readdirSync(attemptLedger)
        .filter(name => name.endsWith('.attempt'))
        .sort()
    } catch {
      process.stderr.write(
        'Hermetic Vitest network-attempt ledger was removed or unreadable\n',
      )
      attemptRecords = ['ledger-unavailable']
    }

    if (attemptRecords.length > 0) {
      process.stderr.write(
        `Hermetic Vitest detected ${attemptRecords.length} unconsumed public-network attempt(s)\n`,
      )
      for (const name of attemptRecords.slice(0, 10)) {
        if (name === 'ledger-unavailable') continue
        try {
          const record = JSON.parse(
            readFileSync(join(attemptLedger, name), 'utf8'),
          )
          const frames = String(record.stack ?? '')
            .split('\n')
            .map(line => line.trim())
            .filter(line =>
              line.startsWith('at ') &&
              !line.includes('network-tripwire.cjs') &&
              !line.includes('node:internal'),
            )
          const callSite =
            frames.find(line => line.includes('/runtime/tests/')) ?? frames[0]
          if (callSite) process.stderr.write(`  ${callSite}\n`)
        } catch {
          process.stderr.write('  unreadable network-attempt record\n')
        }
      }
      exitCode = 1
    }

    if (result.signal !== null) {
      process.stderr.write(`Hermetic Vitest exited on ${result.signal}\n`)
      exitCode = 1
    }
    return exitCode
  } finally {
    rmSync(runRoot, { force: true, recursive: true })
  }
}

process.exitCode = await run()
