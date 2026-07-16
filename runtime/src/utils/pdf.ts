import { randomUUID } from 'crypto'
import { mkdir, readdir, readFile } from 'fs/promises'
import { dirname, join } from 'path'
import {
  PDF_MAX_EXTRACT_SIZE,
  PDF_TARGET_RAW_SIZE,
} from '../constants/apiLimits.js'
import { errorMessage } from './errors.js'
import { formatFileSize } from './format.js'
import { getFsImplementation } from './fsOperations.js'
import { parsePDFInfoPageCount } from './pdfInfo.js'
import { getToolResultsDir } from './toolResultStorage.js'
import type { SandboxExecutionBrokerLike } from '../sandbox/execution-broker.js'
import { scrubEnvForChildProcess } from '../unified-exec/scrub-env.js'
import { runSupervisedProcess } from './supervisedProcess.js'

export type PDFError = {
  reason:
    | 'empty'
    | 'too_large'
    | 'password_protected'
    | 'corrupted'
    | 'unknown'
    | 'unavailable'
  message: string
}

export type PDFResult<T> =
  | { success: true; data: T }
  | { success: false; error: PDFError }

/**
 * Read a PDF file and return it as base64-encoded data.
 * @param filePath Path to the PDF file
 * @returns Result containing PDF data or a structured error
 */
export async function readPDF(filePath: string): Promise<
  PDFResult<{
    type: 'pdf'
    file: {
      filePath: string
      base64: string
      originalSize: number
    }
  }>
> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    // Check if file is empty
    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    // Check if PDF exceeds maximum size
    // The API has a 32MB total request limit. After base64 encoding (~33% larger),
    // a PDF must be under ~20MB raw to leave room for conversation context.
    if (originalSize > PDF_TARGET_RAW_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size of ${formatFileSize(PDF_TARGET_RAW_SIZE)}.`,
        },
      }
    }

    const fileBuffer = await readFile(filePath)

    // Validate PDF magic bytes — reject files that aren't actually PDFs
    // (e.g., HTML files renamed to .pdf) before they enter conversation context.
    // Once an invalid PDF document block is in the message history, every subsequent
    // API call fails with 400 "The PDF specified was not valid" and the session
    // becomes unrecoverable without /clear.
    const header = fileBuffer.subarray(0, 5).toString('ascii')
    if (!header.startsWith('%PDF-')) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: `File is not a valid PDF (missing %PDF- header): ${filePath}`,
        },
      }
    }

    const base64 = fileBuffer.toString('base64')

    // Note: We cannot check page count here without parsing the PDF
    // The API will enforce the 100-page limit and return an error if exceeded

    return {
      success: true,
      data: {
        type: 'pdf',
        file: {
          filePath,
          base64,
          originalSize,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

/**
 * Get the number of pages in a PDF file using `pdfinfo` (from poppler-utils).
 * Returns `null` if pdfinfo is not available or if the page count cannot be determined.
 */
export async function getPDFPageCount(
  filePath: string,
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<number | null> {
  if (sandboxExecutionBroker === undefined) return null
  const result = await runPdfHelper(
    sandboxExecutionBroker,
    'pdfinfo',
    [filePath],
    dirname(filePath),
    10_000,
  )
  if (result.exitCode !== 0 || result.stopReason !== undefined) {
    return null
  }
  return parsePDFInfoPageCount(result.stdout.toString('utf8'))
}

export type PDFExtractPagesResult = {
  type: 'parts'
  file: {
    filePath: string
    originalSize: number
    count: number
    outputDir: string
  }
}

let pdftoppmAvailable: boolean | undefined

/**
 * Reset the pdftoppm availability cache. Used by tests only.
 */
export function resetPdftoppmCache(): void {
  pdftoppmAvailable = undefined
}

/**
 * Check whether the `pdftoppm` binary (from poppler-utils) is available.
 * The result is cached for the lifetime of the process.
 */
export async function isPdftoppmAvailable(
  sandboxExecutionBroker?: SandboxExecutionBrokerLike,
): Promise<boolean> {
  if (pdftoppmAvailable !== undefined) return pdftoppmAvailable
  if (sandboxExecutionBroker === undefined) return false
  const result = await runPdfHelper(
    sandboxExecutionBroker,
    'pdftoppm',
    ['-v'],
    sandboxExecutionBroker.cwd,
    5_000,
  )
  // pdftoppm prints version info to stderr and exits 0 (or sometimes 99 on older versions)
  pdftoppmAvailable =
    result.stopReason === undefined &&
    (result.exitCode === 0 || result.stderr.length > 0)
  return pdftoppmAvailable
}

/**
 * Extract PDF pages as JPEG images using pdftoppm.
 * Produces page-01.jpg, page-02.jpg, etc. in an output directory.
 * This enables reading large PDFs and works with all API providers.
 *
 * @param filePath Path to the PDF file
 * @param options Optional page range (1-indexed, inclusive)
 */
export async function extractPDFPages(
  filePath: string,
  options?: {
    firstPage?: number
    lastPage?: number
    sandboxExecutionBroker?: SandboxExecutionBrokerLike
  },
): Promise<PDFResult<PDFExtractPagesResult>> {
  try {
    const fs = getFsImplementation()
    const stats = await fs.stat(filePath)
    const originalSize = stats.size

    if (originalSize === 0) {
      return {
        success: false,
        error: { reason: 'empty', message: `PDF file is empty: ${filePath}` },
      }
    }

    if (originalSize > PDF_MAX_EXTRACT_SIZE) {
      return {
        success: false,
        error: {
          reason: 'too_large',
          message: `PDF file exceeds maximum allowed size for text extraction (${formatFileSize(PDF_MAX_EXTRACT_SIZE)}).`,
        },
      }
    }

    const broker = options?.sandboxExecutionBroker
    if (broker === undefined) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message: 'PDF rendering requires an authenticated sandbox execution boundary.',
        },
      }
    }
    const available = await isPdftoppmAvailable(broker)
    if (!available) {
      return {
        success: false,
        error: {
          reason: 'unavailable',
          message:
            'pdftoppm is not installed. Install poppler-utils (e.g. `brew install poppler` or `apt-get install poppler-utils`) to enable PDF page rendering.',
        },
      }
    }

    const uuid = randomUUID()
    const outputDir = join(getToolResultsDir(), `pdf-${uuid}`)
    await mkdir(outputDir, { recursive: true })

    // pdftoppm produces files like <prefix>-01.jpg, <prefix>-02.jpg, etc.
    const prefix = join(outputDir, 'page')
    const args = ['-jpeg', '-r', '100']
    if (options?.firstPage) {
      args.push('-f', String(options.firstPage))
    }
    if (options?.lastPage && options.lastPage !== Infinity) {
      args.push('-l', String(options.lastPage))
    }
    args.push(filePath, prefix)
    const command = broker.prepareSpawn('tool', {
      program: 'pdftoppm',
      args,
      cwd: dirname(filePath),
      env: scrubEnvForChildProcess(process.env),
      trustedExecutable: true,
      additionalPermissions: {
        fileSystem: {
          entries: [{
            path: { kind: 'path', path: outputDir },
            access: 'write',
          }],
        },
      },
    })
    const processResult = await runSupervisedProcess(command, {
      timeoutMs: 120_000,
      maxOutputBytes: 4 * 1024 * 1024,
    })
    const code = processResult.exitCode ?? 1
    const stderr = processResult.stderr.toString('utf8')

    if (code !== 0 || processResult.stopReason !== undefined) {
      if (/password/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'password_protected',
            message:
              'PDF is password-protected. Please provide an unprotected version.',
          },
        }
      }
      if (/damaged|corrupt|invalid/i.test(stderr)) {
        return {
          success: false,
          error: {
            reason: 'corrupted',
            message: 'PDF file is corrupted or invalid.',
          },
        }
      }
      return {
        success: false,
        error: { reason: 'unknown', message: `pdftoppm failed: ${stderr}` },
      }
    }

    // Read generated image files and sort naturally
    const entries = await readdir(outputDir)
    const imageFiles = entries.filter(f => f.endsWith('.jpg')).sort()
    const pageCount = imageFiles.length

    if (pageCount === 0) {
      return {
        success: false,
        error: {
          reason: 'corrupted',
          message: 'pdftoppm produced no output pages. The PDF may be invalid.',
        },
      }
    }

    const count = imageFiles.length

    return {
      success: true,
      data: {
        type: 'parts',
        file: {
          filePath,
          originalSize,
          outputDir,
          count,
        },
      },
    }
  } catch (e: unknown) {
    return {
      success: false,
      error: {
        reason: 'unknown',
        message: errorMessage(e),
      },
    }
  }
}

async function runPdfHelper(
  broker: SandboxExecutionBrokerLike,
  program: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
) {
  const command = broker.prepareSpawn('tool', {
    program,
    args,
    cwd,
    env: scrubEnvForChildProcess(process.env),
    trustedExecutable: true,
  })
  return runSupervisedProcess(command, {
    timeoutMs,
    maxOutputBytes: 4 * 1024 * 1024,
  })
}
