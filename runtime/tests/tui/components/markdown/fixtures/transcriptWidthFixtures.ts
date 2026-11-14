/**
 * Markdown fixtures for display-width checks of the chat transcript.
 * The first one is the table from the owner's report (2026-11-11).
 */
export type TranscriptFixture = {
  readonly name: string
  readonly kind: 'table' | 'text'
  readonly markdown: string
}

const VS16 = '️'
const ZWJ = '‍'

export const OWNER_TABLE = [
  '| Fase | Estado | Evidencia |',
  '|---|---|---|',
  '| P1 Backup | ✅ | `edl/boot_stock.img` (96 MiB partición completa, doble lectura sha256 idéntico) |',
  '| P2 Verificación | ✅ | magic ANDROID!, header v2, kernel gzip 15 MB, ramdisk 1123 KB, DTB 294 KB, cmdline legible |',
  '| P3 Parche Magisk | ✅ | `magisk_patched.img` (17.1 MB, unpack válido, ramdisk con Magisk, DTB sin tocar) |',
  '| P4 Flash boot_b | ⏳ | listo para ejecutar: `fastboot flash boot_b magisk_patched.img` |',
  '| P5 Arranque desde b | ⏳ | mitigación preparada: `vbmeta_b` desverificado si AVB rechaza |',
  '| P6 Root | ⏳ | `su -c id` |',
].join('\n')

export const TRANSCRIPT_FIXTURES: readonly TranscriptFixture[] = [
  { name: 'owner-table', kind: 'table', markdown: OWNER_TABLE },
  {
    name: 'emoji-table',
    kind: 'table',
    markdown: [
      '| Kind | Mark | Note |',
      '|---|---|---|',
      '| wide symbol | ✅ ❌ ⚡ ⏳ | drawn in two cells without a selector |',
      `| selector | ⚠${VS16} ❤${VS16} ✔${VS16} ℹ${VS16} | a text symbol plus U+FE0F |`,
      '| text symbol | ⚠ ✔ © ™ ↔ | one cell each |',
      `| joiner | 👨${ZWJ}👩${ZWJ}👧 👩🏽${ZWJ}💻 | one cluster, two cells |`,
      `| flag, tone, keycap | 🇪🇸 👍🏽 1${VS16}⃣ | two cells each |`,
      '| plain | ok | 12 ms |',
    ].join('\n'),
  },
  {
    name: 'cjk-table',
    kind: 'table',
    markdown: [
      '| Script | Sample | Cells |',
      '|---|---|---|',
      '| Japanese | 日本語のテキスト | 16 |',
      '| Korean | 한국어 텍스트 | 13 |',
      '| Fullwidth | ＡＢＣ１２３ | 12 |',
      '| Combining | café mañana | 11 |',
      '| Decomposed kana | がぎぐ | 6 |',
      '| Decomposed Hangul | 한글 | 4 |',
      '| Mixed | 状態 ok ✅ 完了 | 14 |',
    ].join('\n'),
  },
  {
    name: 'styled-table',
    kind: 'table',
    markdown: [
      '| Item | Value | Link | Right |',
      '|:---|:---:|---|---:|',
      '| `runtime/src/tui/ink/stringWidth.ts` | **bold 42** | [docs](https://example.com/docs) | 1.5 GB |',
      '| *emphasis* |  | https://example.com/a/b | 96 MiB |',
      '|  | `a b` | [✅ done](https://example.com/ok) | 1123 KB |',
      '| **✅ `code` 日本** | x |  | 0 |',
    ].join('\n'),
  },
  {
    name: 'wrapping-table',
    kind: 'table',
    markdown: [
      '| Step | Result | Detail |',
      '|---|---|---|',
      '| Build | ✅ | The build finished in 12.5 s and wrote 3 files to `/home/user/project/dist/bin/agenc.js`, 96 MiB in total, sha256 0f3a9c1e77b2 |',
      '| Test | ❌ | 1123 of 1130 tests passed. The 7 failures are in `tests/tui/components/markdown/MarkdownTable.test.tsx` and need a second look |',
      '| 配布 | ⏳ | 日本語の長い説明文がここに入ります。折り返しても文字が欠けたり重なったりしてはいけません。 |',
      '| Deploy | ⚠️ | waiting for approval, see https://example.com/releases/2026/11/very/long/path/that/cannot/break/anywhere/index.html |',
    ].join('\n'),
  },
  {
    name: 'many-column-table',
    kind: 'table',
    markdown: [
      '| Model | Lane | Speed | Tokens in | Tokens out | Solved | Cost | Wall | Verdict |',
      '|---|---|---|---|---|---|---|---|---|',
      '| alpha-large | fast | 142.7 tok/s | 1,204,331 | 88,412 | 40/44 | $3.12 | 18 min 4 s | ✅ wins |',
      '| beta-medium | slow | 96.1 tok/s | 1,877,902 | 102,115 | 38/44 | $4.80 | 25 min 31 s | ❌ loses |',
      '| gamma-small | fast | 201.3 tok/s | 990,014 | 71,030 | 37/44 | $1.07 | 14 min 9 s | ⏳ pending |',
    ].join('\n'),
  },
  {
    name: 'plain-text',
    kind: 'text',
    markdown: [
      'The backup of `edl/boot_stock.img` took 12.5 s and read 96 MiB at 7.68 MiB/s, then the second read gave the same sha256 0f3a9c1e77b2d4455a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b, so the image is good.',
      '',
      'Next step ✅ done, ⏳ pending, ⚠️ blocked: flash `/home/user/android/work/out/magisk_patched.img` (17.1 MB) with `fastboot flash boot_b magisk_patched.img` and compare 1123 KB against 1,123,456 bytes, 294 KB, 15 MB, 3.14159, 0x7fffffff and 2026-11-11T19:15:10Z.',
      '',
      '日本語の文章は単語の間に空白がありません。折り返しても文字が欠けたり重なったりしてはいけません。数値は 1123 KB と 96 MiB です。',
      '',
      'A link with a long address: https://example.com/releases/2026/11/very/long/path/that/cannot/break/anywhere/index.html?query=1&other=2 and text after it.',
    ].join('\n'),
  },
  {
    name: 'blocks',
    kind: 'text',
    markdown: [
      '## Heading with ✅ and 日本語',
      '',
      '- First item with enough words to wrap at a narrow width, 1123 KB and `inline code` inside it',
      '  - Nested item ✅ that is also long enough to wrap when the terminal is narrow, 96 MiB',
      '    - Third level ⏳ item',
      '- Second item',
      '',
      '1. Ordered item one with a path `/home/user/project/runtime/src/tui/ink/stringWidth.ts` in it',
      '2. Ordered item two',
      '',
      '> A block quote with ✅ and enough words to wrap at a narrow terminal width, so the bar must stay in place.',
      '',
      '```ts',
      'function width(text: string): number {',
      '  if (text.length === 0) {',
      '    return 0 // ✅ 日本語',
      '  }',
      '  return measure(text)',
      '}',
      '```',
    ].join('\n'),
  },
  {
    name: 'lists',
    kind: 'text',
    markdown: [
      '- Loose item one, with a blank line after it',
      '',
      '- Loose item two ✅',
      '',
      '  A second paragraph of item two that is long enough to wrap at a narrow terminal width.',
      '',
      '- Parent',
      '  - Child one',
      '  - Child two',
      '    - Grandchild one ⏳',
      '    - Grandchild two',
      '  - Child three',
      '',
      '1. Step one',
      '',
      '   ```sh',
      '   fastboot flash boot_b magisk_patched.img',
      '   ```',
      '',
      '2. Step two',
      '',
      '- [ ] Open task',
      '- [x] Closed task',
    ].join('\n'),
  },
]

export const FIXTURE_WIDTHS = [60, 80, 120, 160] as const
