#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const runtimeRoot = dirname(scriptDir)
const testsRoot = join(runtimeRoot, 'tests')

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

if (!existsSync(testsRoot)) {
  console.error(`Missing tests directory: ${testsRoot}`)
  process.exit(1)
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
    env: process.env,
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
  process.exit(1)
}
