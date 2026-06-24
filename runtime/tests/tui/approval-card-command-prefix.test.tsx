import React from 'react'
import { describe, expect, test } from 'vitest'

import { Box } from '../../src/tui/ink.js'
import {
  ApprovalCard,
  type ApprovalDiffPreview,
} from '../../src/tui/components/v2/primitives.js'
import { buildEditDiffPreview } from '../../src/tui/edit-diff-preview.js'
import { renderToString } from '../../src/utils/staticRender.js'

// BUG 4 (MEDIUM): the approval dialog rendered the tool input unconditionally as
// `$ {command}`. The `$ ` is a shell-prompt marker — correct for Run/Bash, but
// for a Write/Edit tool the input is a bare file path, so the card showed
// `$ config_validator/validator.py`, which reads as a runnable command (it isn't)
// AND duplicates the `CREATE path` diff header. The fix makes the `$ ` prefix
// conditional on `commandIsShell`, and omits the redundant path line entirely
// when a diff header already names the file.

function writePreview(): ApprovalDiffPreview {
  const built = buildEditDiffPreview('Write', {
    file_path: 'config_validator/validator.py',
    content: 'a = 1\nb = 2\n',
  })
  if (built === null) throw new Error('expected a Write diff preview')
  return {
    file: built.file,
    stats: built.stats,
    lines: built.lines,
    remaining: built.remaining,
    op: 'CREATE',
  }
}

describe('ApprovalCard command prefix (BUG 4: no `$ ` shell glyph on file paths)', () => {
  test('a Run/Bash command keeps the `$ ` shell-prompt prefix', async () => {
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · run · needs approval"
          command="rm -rf build"
          commandIsShell={true}
          facts={[{ label: 'tool', value: 'run' }]}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    expect(out).toMatch(/\$ rm -rf build/)
  })

  test('a Write file path is shown WITHOUT a `$ ` shell-prompt prefix', async () => {
    // No diff preview here, so the bare path IS shown — but never behind `$ `.
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · write · needs approval"
          command="config_validator/validator.py"
          commandIsShell={false}
          facts={[{ label: 'tool', value: 'write' }]}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    expect(out).toContain('config_validator/validator.py')
    // The path line is present but NOT prefixed with the shell-prompt glyph.
    expect(out).not.toMatch(/\$ config_validator\/validator\.py/)
  })

  test('a Write WITH a diff header omits the redundant bare path line', async () => {
    const out = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="tool · write · needs approval"
          command="config_validator/validator.py"
          commandIsShell={false}
          facts={[{ label: 'tool', value: 'write' }]}
          diffPreview={writePreview()}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    // The CREATE diff header still names the file …
    expect(out).toContain('CREATE')
    // … and there is NO standalone command/path line for the file (the bare
    // `config_validator/validator.py` line that used to render between the
    // summary and the diff). The path still appears in the approval SUMMARY line
    // (which lists the primary fact) and in the CREATE diff header — but never as
    // its own `$ path` / bare-path line. So a row that is JUST the path (only
    // popup chrome + whitespace + the path, no other words) must not exist.
    const standalonePathRow = out.split('\n').find((l) => {
      const stripped = l.replace(/[│┌┐└┘─\s]/g, '')
      return stripped === 'config_validator/validator.py'
    })
    expect(standalonePathRow).toBeUndefined()
    // Never behind a `$ ` prompt glyph.
    expect(out).not.toMatch(/\$ config_validator\/validator\.py/)
  })

  test('REVERT-SENSITIVITY: shell vs file path differ ONLY by the `$ ` glyph', async () => {
    const shell = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="t"
          command="some/path/here.py"
          commandIsShell={true}
          facts={[{ label: 'tool', value: 'run' }]}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    const file = await renderToString(
      <Box flexDirection="column">
        <ApprovalCard
          risk="low"
          title="t"
          command="some/path/here.py"
          commandIsShell={false}
          facts={[{ label: 'tool', value: 'run' }]}
          confirmLabel="enter approve · 2 session · 3 deny"
        />
      </Box>,
      { columns: 116, rows: 40 },
    )
    // The shell card prefixes the value with `$ `; the file card does not.
    expect(shell).toMatch(/\$ some\/path\/here\.py/)
    expect(file).not.toMatch(/\$ some\/path\/here\.py/)
    expect(file).toContain('some/path/here.py')
  })
})
