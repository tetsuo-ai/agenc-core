import React, { useContext } from 'react'
import { describe, expect, test } from 'vitest'

import { renderToString } from '../../../utils/staticRender.js'
import AppContext, { useApp, type Props as AppContextProps } from './AppContext.js'
import CursorDeclarationContext, {
  type CursorDeclarationSetter,
} from './CursorDeclarationContext.js'
import StdinContext, {
  useStdin,
  type Props as StdinContextProps,
} from './StdinContext.js'
import Text from './Text.js'

function getDefaultContextValue<T>(context: unknown): T {
  const value = context as { _currentValue?: T; _currentValue2?: T }
  const current = value._currentValue ?? value._currentValue2
  if (current === undefined) throw new Error('missing context default value')
  return current
}

describe('Ink context hooks', () => {
  test('returns and exercises the default app context', async () => {
    let captured: AppContextProps | undefined
    const defaultValue = getDefaultContextValue<AppContextProps>(AppContext)

    function Probe() {
      captured = useApp()
      return <Text>app</Text>
    }

    const output = await renderToString(<Probe />, 20)

    expect(output).toContain('app')
    expect(AppContext.displayName).toBe('InternalAppContext')
    expect(captured).toBeDefined()
    expect(() => captured?.exit()).not.toThrow()
    expect(() => defaultValue.exit(new Error('ignored'))).not.toThrow()
  })

  test('returns and exercises the default stdin context', async () => {
    let captured: StdinContextProps | undefined
    const defaultValue = getDefaultContextValue<StdinContextProps>(StdinContext)

    function Probe() {
      captured = useStdin()
      return <Text>stdin</Text>
    }

    const output = await renderToString(<Probe />, 20)

    expect(output).toContain('stdin')
    expect(StdinContext.displayName).toBe('InternalStdinContext')
    expect(captured).toBeDefined()
    expect(defaultValue.stdin).toBe(process.stdin)
    expect(defaultValue.isRawModeSupported).toBe(false)
    expect(defaultValue.internal_exitOnCtrlC).toBe(true)
    expect(defaultValue.internal_querier).toBeNull()
    expect(defaultValue.internal_eventEmitter).toBeDefined()
    expect(() => defaultValue.setRawMode(true)).not.toThrow()
  })

  test('uses the default cursor declaration setter as a no-op', async () => {
    let setCursorDeclaration: CursorDeclarationSetter | undefined
    const defaultValue =
      getDefaultContextValue<CursorDeclarationSetter>(CursorDeclarationContext)

    function Probe() {
      setCursorDeclaration = useContext(CursorDeclarationContext)
      return <Text>cursor</Text>
    }

    const output = await renderToString(<Probe />, 20)

    expect(output).toContain('cursor')
    expect(setCursorDeclaration).toBeDefined()
    expect(() => setCursorDeclaration?.(null)).not.toThrow()
    expect(() =>
      defaultValue({
        node: {} as never,
        relativeX: 1,
        relativeY: 2,
      }),
    ).not.toThrow()
  })
})
