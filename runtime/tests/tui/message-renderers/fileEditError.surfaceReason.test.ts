import { describe, expect, test } from 'vitest'

import { summarizeFileEditError } from '../../tools/FileEditTool/UI.js'
import { FILE_NOT_FOUND_CWD_NOTE } from '../../utils/file.js'

describe('summarizeFileEditError - surfaces the concrete reason', () => {
  test('returns a friendly message for the intended "not read yet" case', () => {
    const result = summarizeFileEditError(
      '<tool_use_error>File has not been read yet. Read it first before writing to it.</tool_use_error>',
    )
    expect(result).toBe('File must be read first')
  })

  test('returns a friendly message for the not-found case', () => {
    const result = summarizeFileEditError(
      `<tool_use_error>File does not exist. ${FILE_NOT_FOUND_CWD_NOTE} /repo</tool_use_error>`,
    )
    expect(result).toBe('File not found')
  })

  test('surfaces the concrete one-line reason instead of a generic mask', () => {
    const result = summarizeFileEditError(
      '<tool_use_error>String to replace not found in file.\nString: old_thing</tool_use_error>',
    )
    // Must be the real reason, NOT the old generic "Error editing file".
    expect(result).toBe('String to replace not found in file.')
    expect(result).not.toBe('Error editing file')
  })

  test('uses the first non-empty line and strips wrapper <error> tags', () => {
    const result = summarizeFileEditError(
      '<tool_use_error><error>\n\nFound 3 matches but replace_all is false\n</error></tool_use_error>',
    )
    expect(result).toBe('Found 3 matches but replace_all is false')
  })

  test('returns null when there is no usable error text', () => {
    expect(summarizeFileEditError('')).toBeNull()
    expect(summarizeFileEditError('<tool_use_error>   </tool_use_error>')).toBeNull()
    expect(summarizeFileEditError(undefined as unknown as string)).toBeNull()
  })
})
