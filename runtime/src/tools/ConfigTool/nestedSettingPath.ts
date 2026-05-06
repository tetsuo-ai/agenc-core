export function getNestedSettingValue(source: unknown, path: string[]): unknown {
  let current: unknown = source
  for (const key of path) {
    if (current && typeof current === 'object' && key in current) {
      current = (current as Record<string, unknown>)[key]
    } else {
      return undefined
    }
  }
  return current
}

export function setNestedSettingValue<T extends Record<string, unknown>>(
  source: T,
  path: string[],
  value: unknown,
): T {
  const key = path[0]
  if (!key) return source

  const out: Record<string, unknown> = { ...source }
  let cursor = out
  for (let i = 0; i < path.length - 1; i++) {
    const part = path[i]!
    const existing = cursor[part]
    const next =
      existing && typeof existing === 'object' && !Array.isArray(existing)
        ? { ...(existing as Record<string, unknown>) }
        : {}
    cursor[part] = next
    cursor = next
  }
  cursor[path[path.length - 1]!] = value
  return out as T
}

export function setGlobalConfigSettingValue<
  T extends Record<string, unknown>,
>(source: T, setting: string, path: string[], value: unknown): T {
  const next = setNestedSettingValue(source, path, value) as Record<
    string,
    unknown
  >

  if (setting === 'tui.vimMode' && typeof value === 'boolean') {
    return {
      ...next,
      editorMode: value ? 'vim' : 'normal',
    } as unknown as T
  }

  if (setting === 'editorMode' && typeof value === 'string') {
    return {
      ...next,
      tui: {
        ...((next.tui && typeof next.tui === 'object'
          ? next.tui
          : {}) as Record<string, unknown>),
        vimMode: value === 'vim',
      },
    } as unknown as T
  }

  return next as T
}
