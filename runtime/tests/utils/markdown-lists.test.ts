import stripAnsi from 'strip-ansi'
import { describe, expect, test } from 'vitest'

import { applyMarkdown } from './markdown.js'

function plain(markdown: string): string[] {
  return stripAnsi(applyMarkdown(markdown, 'dark')).split('\n')
}

describe('markdown lists as text', () => {
  test('items separated by blank lines keep their markers', () => {
    expect(plain('- one\n\n- two\n\n- three')).toEqual(['- one', '- two', '- three'])
    expect(plain('1. one\n\n2. two')).toEqual(['1. one', '2. two'])
  })

  test('nested items sit two cells deeper per level, siblings in one column', () => {
    expect(
      plain(
        ['- Parent', '  - Child one', '  - Child two', '    - Grandchild one', '    - Grandchild two', '  - Child three', '- Last'].join('\n'),
      ),
    ).toEqual([
      '- Parent',
      '  - Child one',
      '  - Child two',
      '    - Grandchild one',
      '    - Grandchild two',
      '  - Child three',
      '- Last',
    ])
  })

  test('ordered levels keep their numbering styles', () => {
    expect(plain(['1. one', '   1. inner one', '   2. inner two', '2. two'].join('\n'))).toEqual([
      '1. one',
      '  a. inner one',
      '  b. inner two',
      '2. two',
    ])
  })

  test('task list boxes are shown', () => {
    expect(plain('- [ ] open\n- [x] closed')).toEqual(['- [ ] open', '- [x] closed'])
  })

  test('later paragraphs and code of an item line up under its text', () => {
    expect(
      plain(['1. Step one', '', '   ```sh', '   fastboot flash boot_b', '     indented', '   ```', '', '2. Step two', '', '   More text.'].join('\n')),
    ).toEqual([
      '1. Step one',
      '',
      '   fastboot flash boot_b',
      '     indented',
      '2. Step two',
      '',
      '   More text.',
    ])
  })

  test('inline styles inside an item are kept', () => {
    expect(plain('- **bold** and `code` and *more*')).toEqual([
      '- bold and code and more',
    ])
  })
})
