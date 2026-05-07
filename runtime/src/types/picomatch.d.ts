declare module 'picomatch' {
  type PicomatchOptions = Record<string, unknown>

  const picomatch: {
    isMatch(
      input: string,
      patterns: string | readonly string[],
      options?: PicomatchOptions,
    ): boolean
  }

  export default picomatch
}
