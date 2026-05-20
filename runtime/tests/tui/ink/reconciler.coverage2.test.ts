import { expect, test } from 'vitest'

import { getOwnerChain } from './reconciler.ts'

type ComponentFn = (() => null) & {
  displayName?: string
}

type TestFiber = {
  elementType?: ComponentFn | string | { displayName?: string; name?: string } | null
  _debugOwner?: TestFiber | null
  return?: TestFiber | null
}

function FunctionNameOwner(): null {
  return null
}

test('walks reconciler owner fibers while skipping hosts, repeats, and cycles', () => {
  const DisplayNameOwner = (() => null) as ComponentFn
  DisplayNameOwner.displayName = 'DisplayNameOwner'

  const ignoredHostReturn: TestFiber = {
    elementType: { displayName: 'IgnoredHostReturn' },
  }
  const objectNameOwner: TestFiber = {
    elementType: { name: 'ObjectNameOwner' },
  }
  const debugOwner: TestFiber = {
    elementType: DisplayNameOwner,
    return: objectNameOwner,
  }
  const hostFiber: TestFiber = {
    elementType: 'ink-box',
    _debugOwner: debugOwner,
    return: ignoredHostReturn,
  }
  const leafFiber: TestFiber = {
    elementType: FunctionNameOwner,
    _debugOwner: hostFiber,
  }

  expect(getOwnerChain(leafFiber)).toEqual([
    'FunctionNameOwner',
    'DisplayNameOwner',
    'ObjectNameOwner',
  ])

  const repeatedParent: TestFiber = {
    elementType: { name: 'RepeatedOwner' },
  }
  const repeatedChild: TestFiber = {
    elementType: { displayName: 'RepeatedOwner' },
    return: repeatedParent,
  }

  expect(getOwnerChain(repeatedChild)).toEqual(['RepeatedOwner'])

  const cyclicOwner: TestFiber = {
    elementType: { displayName: 'CyclicOwner' },
  }
  cyclicOwner.return = cyclicOwner

  expect(getOwnerChain(cyclicOwner)).toEqual(['CyclicOwner'])
  expect(getOwnerChain(null)).toEqual([])
})
