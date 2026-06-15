declare module 'shell-quote' {
  export type ControlOperator =
    | '||'
    | '&&'
    | ';;'
    | '|&'
    | '<('
    | '<<<'
    | '>>'
    | '>&'
    | '<&'
    | '&'
    | ';'
    | '('
    | ')'
    | '|'
    | '<'
    | '>'

  export type OperatorToken = {
    op: ControlOperator
  }

  export type GlobToken = {
    op: 'glob'
    pattern: string
  }

  export type CommentToken = {
    comment: string
  }

  export type ParseEntry =
    | string
    | OperatorToken
    | GlobToken
    | CommentToken

  export type Environment =
    | Record<string, string | ParseEntry | undefined>
    | ((key: string) => string | ParseEntry | undefined)

  export type ParseOptions = {
    escape?: string
  }

  export function parse(
    cmd: string,
    env?: Environment,
    opts?: ParseOptions,
  ): ParseEntry[]

  export function quote(
    args: ReadonlyArray<string | OperatorToken | GlobToken | CommentToken>,
  ): string
}
