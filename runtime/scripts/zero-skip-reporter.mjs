import {
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { isAbsolute } from 'node:path'

export const ZERO_SKIP_REPORT_ENV_VAR = 'AGENC_TEST_ZERO_SKIP_REPORT'
export const ZERO_SKIP_REPORT_SCHEMA_VERSION = 1

function normalizePath(value) {
  return value.split(/[/\\]+/u).join('/')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function readZeroSkipEvidence(reportPath) {
  const parsed = JSON.parse(readFileSync(reportPath, 'utf8'))
  if (
    !isRecord(parsed) ||
    parsed.schemaVersion !== ZERO_SKIP_REPORT_SCHEMA_VERSION ||
    !Array.isArray(parsed.skippedTests)
  ) {
    throw new Error('zero-skip report has an invalid schema')
  }

  const skippedTests = parsed.skippedTests.map((entry, index) => {
    if (
      !isRecord(entry) ||
      typeof entry.file !== 'string' ||
      entry.file.length === 0 ||
      typeof entry.name !== 'string' ||
      entry.name.length === 0 ||
      typeof entry.mode !== 'string' ||
      entry.mode.length === 0
    ) {
      throw new Error(`zero-skip report entry ${index} is invalid`)
    }
    return {
      file: normalizePath(entry.file),
      mode: entry.mode,
      name: entry.name,
    }
  })

  return {
    schemaVersion: ZERO_SKIP_REPORT_SCHEMA_VERSION,
    skippedTests,
  }
}

export default class ZeroSkipReporter {
  onTestRunEnd(testModules) {
    const reportPath = process.env[ZERO_SKIP_REPORT_ENV_VAR]
    if (
      typeof reportPath !== 'string' ||
      !isAbsolute(reportPath) ||
      reportPath.includes('\0')
    ) {
      throw new Error('zero-skip reporter requires an absolute evidence path')
    }

    const skippedTests = []
    for (const testModule of testModules) {
      for (const testCase of testModule.children.allTests()) {
        if (testCase.result().state !== 'skipped') continue
        skippedTests.push({
          file: normalizePath(testCase.module.relativeModuleId),
          mode: testCase.options.mode,
          name: testCase.fullName,
        })
      }
    }
    skippedTests.sort((left, right) =>
      left.file.localeCompare(right.file) ||
      left.name.localeCompare(right.name) ||
      left.mode.localeCompare(right.mode),
    )

    writeFileSync(
      reportPath,
      `${JSON.stringify({
        schemaVersion: ZERO_SKIP_REPORT_SCHEMA_VERSION,
        skippedTests,
      })}\n`,
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    )
  }
}
