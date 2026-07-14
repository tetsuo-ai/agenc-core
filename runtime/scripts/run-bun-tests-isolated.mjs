#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
} from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createHermeticLaunchEnv,
  createHermeticRunRoot,
  sanitizeHermeticEnv,
} from '../tests/helpers/hermetic-env.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const runtimeRoot = dirname(scriptDir)
const testsRoot = join(runtimeRoot, 'tests')

// Suite-level hermeticity (TODO task 30): `bun test` children never load
// vitest's setupFiles, so apply the same explicit sanitization here — strip
// ambient provider keys / developer AgenC state, point AGENC_HOME at a
// throwaway temp dir, and pin AGENC_AUTH_BACKEND=local so no child performs
// a real device-code login against https://id.agenc.ag.
// See tests/helpers/hermetic-env.mjs for the documented strip list.
function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...walk(path))
      continue
    }
    if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)) {
      files.push(path)
    }
  }
  return files
}

function isBunTestFile(path) {
  const source = readFileSync(path, 'utf8')
  return source.includes("from 'bun:test'") || source.includes('from "bun:test"')
}

function run() {
  const runRoot = createHermeticRunRoot('agb-')
  try {
    const home = join(runRoot, 'home')
    mkdirSync(home, { mode: 0o700, recursive: true })
    const hermeticEnv = sanitizeHermeticEnv(
      createHermeticLaunchEnv(process.env, runRoot),
      home,
    )

    if (!existsSync(testsRoot)) {
      console.error(`Missing tests directory: ${testsRoot}`)
      return 1
    }

    const files = walk(testsRoot)
      .filter(isBunTestFile)
      .map(path => relative(runtimeRoot, path))
      .sort()

    let failed = 0
    const failedFiles = []

    for (const file of files) {
      const result = spawnSync('bun', ['test', file], {
        cwd: runtimeRoot,
        encoding: 'utf8',
        env: hermeticEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      if (result.status !== 0) {
        failed += 1
        failedFiles.push(file)
        console.error(`FAIL ${file}`)
        if (result.stdout) console.error(result.stdout.trimEnd())
        if (result.stderr) console.error(result.stderr.trimEnd())
      }
    }

    console.log(`isolated bun tests: files=${files.length} failed=${failed}`)

    if (failed > 0) {
      console.error(`failed files:\n${failedFiles.join('\n')}`)
      return 1
    }
    return 0
  } finally {
    rmSync(runRoot, { force: true, recursive: true })
  }
}

process.exitCode = run()
