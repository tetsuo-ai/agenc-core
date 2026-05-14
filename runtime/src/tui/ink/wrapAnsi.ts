import wrapAnsiNpm from 'wrap-ansi'

type WrapAnsiOptions = {
  hard?: boolean
  wordWrap?: boolean
  trim?: boolean
}

const wrapAnsiBun =
  typeof Bun !== 'undefined'
    ? (Bun as unknown as { readonly wrapAnsi?: typeof wrapAnsiNpm }).wrapAnsi
    : undefined

const wrapAnsi: (
  input: string,
  columns: number,
  options?: WrapAnsiOptions,
) => string = typeof wrapAnsiBun === 'function' ? wrapAnsiBun : wrapAnsiNpm

export { wrapAnsi }
