import { expect, it, vi } from 'vitest'

vi.mock('../../src/utils/memoize.js', async (original) => {
  const actual = await original<typeof import('../../src/utils/memoize.js')>()
  return { ...actual, memoizeWithLRU: vi.fn(actual.memoizeWithLRU) }
})
import { memoizeWithLRU } from '../../src/utils/memoize.js'
import { windowsPathToPosixPath, posixPathToWindowsPath } from '../../src/utils/windowsPaths.js'

it('allocates neither LRU on import or empty-cache operations, then one per converter', () => {
  for (const convert of [windowsPathToPosixPath, posixPathToWindowsPath]) {
    const cache = convert.cache
    expect(cache.size()).toBe(0)
    expect(cache.get('missing')).toBeUndefined()
    expect(cache.has('missing')).toBe(false)
    expect(cache.delete('missing')).toBe(false)
    expect(cache.clear()).toBeUndefined()
    expect(convert.cache).toBe(cache)
  }
  expect(memoizeWithLRU).not.toHaveBeenCalled()
  const windowsCache = windowsPathToPosixPath.cache
  expect(windowsPathToPosixPath('C:\\temp')).toBe('/c/temp')
  expect(windowsPathToPosixPath.cache).toBe(windowsCache)
  expect(windowsPathToPosixPath('C:\\temp')).toBe('/c/temp')
  expect(memoizeWithLRU).toHaveBeenCalledTimes(1)
  const posixCache = posixPathToWindowsPath.cache
  expect(posixPathToWindowsPath('/c/temp')).toBe('C:\\temp')
  expect(posixPathToWindowsPath.cache).toBe(posixCache)
  expect(memoizeWithLRU).toHaveBeenCalledTimes(2)
  expect(vi.mocked(memoizeWithLRU).mock.calls.map(call => call[2])).toEqual([500, 500])
})

it('retains max 500, call-hit recency, non-promoting cache reads and independent invalidation', () => {
  for (const convert of [windowsPathToPosixPath, posixPathToWindowsPath]) {
    const cache = convert.cache
    cache.clear()
    for (let i = 0; i < 500; i++) convert(`path/${i}`)
    expect(cache.size()).toBe(500)
    convert('path/0') // Calling the converter promotes a hit.
    const first = cache.get('path/1') // Observing through the facade does not.
    expect(first).toBeDefined()
    expect(cache.has('path/1')).toBe(true)
    convert('path/500')
    expect(cache.size()).toBe(500)
    expect(cache.has('path/0')).toBe(true)
    expect(cache.has('path/1')).toBe(false)
    expect(cache.delete('path/0')).toBe(true)
    expect(cache.delete('path/0')).toBe(false)
    expect(cache.size()).toBe(499)
    cache.clear()
    expect(cache.size()).toBe(0)
  }
  windowsPathToPosixPath('C:\\only-windows')
  posixPathToWindowsPath.cache.clear()
  expect(windowsPathToPosixPath.cache.size()).toBe(1)
  expect(posixPathToWindowsPath.cache.size()).toBe(0)
  expect(memoizeWithLRU).toHaveBeenCalledTimes(2)
})

it.each([
  ['//server/share/a', '\\\\server\\share\\a'],
  ['/cygdrive/d/a', 'D:\\a'], ['/cygdrive/d', 'D:\\'],
  ['/c/a', 'C:\\a'], ['/c', 'C:\\'], ['/tmp/a', '\\tmp\\a'],
  ['relative/a', 'relative\\a'], ['', ''], ['D:\\a', 'D:\\a'],
])('preserves POSIX conversion of %s', (input, expected) => {
  expect(posixPathToWindowsPath(input)).toBe(expected)
})
