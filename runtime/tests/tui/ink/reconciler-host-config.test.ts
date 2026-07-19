import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test, vi } from 'vitest'

type HostConfig = Record<string, (...args: any[]) => any> & {
  HostTransitionContext: { $$typeof: symbol; _currentValue: null }
  NotPendingTransition: null
}

type FakeReconciler = {
  discreteUpdates: ReturnType<typeof vi.fn>
}

const reconcilerMock = vi.hoisted(() => ({
  hostConfig: undefined as HostConfig | undefined,
  fakeReconciler: {
    discreteUpdates: vi.fn(),
  } as FakeReconciler,
}))

// resetModules intentionally preserves Vitest's `mock:` module entries. Keep
// one stable mock function across repeated dynamic imports and move only its
// capture target; cycling closure-scoped doMock/doUnmock factories can reuse a
// cached mock whose capture belongs to an earlier import.
vi.mock('react-reconciler', () => ({
  default: (config: HostConfig) => {
    reconcilerMock.hostConfig = config
    return reconcilerMock.fakeReconciler
  },
}))

async function importHostConfig(): Promise<{
  hostConfig: HostConfig
  fakeReconciler: FakeReconciler
  module: typeof import('./reconciler.ts')
  dom: typeof import('./dom.ts')
  focus: typeof import('./focus.ts')
}> {
  vi.resetModules()
  reconcilerMock.hostConfig = undefined
  reconcilerMock.fakeReconciler.discreteUpdates
    .mockReset()
    .mockImplementation((fn, ...args) => fn(...args))

  const [module, dom, focus] = await Promise.all([
    import('./reconciler.ts'),
    import('./dom.ts'),
    import('./focus.ts'),
  ])

  if (!reconcilerMock.hostConfig) {
    throw new Error('Expected reconciler host config to be captured')
  }

  return {
    hostConfig: reconcilerMock.hostConfig,
    fakeReconciler: reconcilerMock.fakeReconciler,
    module,
    dom,
    focus,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

test('development devtools loader handles optional missing module asynchronously', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

  try {
    vi.resetModules()
    process.env.NODE_ENV = 'test'
    const { loadDevtoolsForDevelopment } = await import('./reconciler.ts')

    const skippedImporter = vi.fn(async () => undefined)
    await loadDevtoolsForDevelopment(skippedImporter)

    expect(skippedImporter).not.toHaveBeenCalled()

    process.env.NODE_ENV = 'development'
    await loadDevtoolsForDevelopment()

    const missingError = Object.assign(new Error('missing devtools'), {
      code: 'ERR_MODULE_NOT_FOUND',
    })
    const missingImporter = vi.fn(async () => {
      throw missingError
    })

    await loadDevtoolsForDevelopment(missingImporter)

    expect(missingImporter).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls.at(-1)?.[0]).toContain('React Devtools requires it')

    const unexpectedError = new Error('devtools exploded')
    await expect(
      loadDevtoolsForDevelopment(async () => {
        throw unexpectedError
      }),
    ).rejects.toBe(unexpectedError)
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
  }
})

test('host config mutates mounted nodes, focus, text, visibility, and event props', async () => {
  const previousDebugRepaints = process.env.AGENC_DEBUG_REPAINTS
  process.env.AGENC_DEBUG_REPAINTS = '1'

  try {
    const { hostConfig, fakeReconciler, module, dom, focus } =
      await importHostConfig()
    const rootContext = hostConfig.getRootHostContext()
    const root = dom.createNode('ink-root')
    const dispatchFocusEvent = vi.fn(() => true)
    root.focusManager = new focus.FocusManager(dispatchFocusEvent)

    expect(rootContext).toEqual({ isInsideText: false })
    expect(hostConfig.preparePortalMount()).toBeNull()
    expect(hostConfig.clearContainer()).toBe(false)
    expect(hostConfig.shouldSetTextContent()).toBe(false)

    const textContext = hostConfig.getChildHostContext(rootContext, 'ink-text')
    expect(textContext).toEqual({ isInsideText: true })
    expect(hostConfig.getChildHostContext(rootContext, 'ink-box')).toBe(
      rootContext,
    )
    expect(hostConfig.getChildHostContext(textContext, 'ink-link')).toBe(
      textContext,
    )
    expect(hostConfig.getChildHostContext(textContext, 'ink-box')).toEqual({
      isInsideText: false,
    })

    const onClick = vi.fn()
    const ownerFiber = {
      elementType: { name: 'ButtonOwner' },
    }
    const box = hostConfig.createInstance(
      'ink-box',
      {
        id: 'box',
        tabIndex: 0,
        autoFocus: true,
        style: { paddingLeft: 1 },
        textStyles: { bold: true },
        onClick,
        children: 'ignored',
      },
      root,
      rootContext,
      ownerFiber,
    )

    expect(box.attributes).toMatchObject({
      id: 'box',
      tabIndex: 0,
      autoFocus: true,
    })
    expect(box.attributes.children).toBeUndefined()
    expect(box.style).toMatchObject({ paddingLeft: 1 })
    expect(box.textStyles).toEqual({ bold: true })
    expect(box._eventHandlers?.onClick).toBe(onClick)
    expect(box.debugOwnerChain).toEqual(['ButtonOwner'])
    expect(hostConfig.getPublicInstance(box)).toBe(box)

    expect(() =>
      hostConfig.createInstance('ink-box', {}, root, textContext),
    ).toThrow("<Box> can't be nested inside <Text> component")
    expect(
      hostConfig.createInstance('ink-text', {}, root, textContext).nodeName,
    ).toBe('ink-virtual-text')

    const text = hostConfig.createTextInstance('hello', root, rootContext)
    hostConfig.hideTextInstance(text)
    expect(text.nodeValue).toBe('')
    hostConfig.unhideTextInstance(text, 'restored')
    expect(text.nodeValue).toBe('restored')
    hostConfig.commitTextUpdate(text, 'restored', 'updated')
    expect(text.nodeValue).toBe('updated')
    hostConfig.resetTextContent(box)

    expect(
      hostConfig.finalizeInitialChildren(box, 'ink-box', { autoFocus: true }),
    ).toBe(true)
    expect(hostConfig.finalizeInitialChildren(box, 'ink-box', {})).toBe(false)

    hostConfig.appendChildToContainer(root, box)
    hostConfig.commitMount(box)
    expect(root.focusManager.activeElement).toBe(box)

    hostConfig.hideInstance(box)
    expect(box.isHidden).toBe(true)
    expect(box.yogaNode?.getDisplay()).toBe('none')

    hostConfig.unhideInstance(box)
    expect(box.isHidden).toBe(false)
    expect(box.yogaNode?.getDisplay()).toBe('flex')

    expect(
      hostConfig.prepareUpdate(
        box,
        'ink-box',
        { id: 'box', style: { paddingLeft: 1 }, children: 'old child' },
        { id: 'box', style: { paddingLeft: 1 }, children: 'new child' },
      ),
    ).toBeNull()
    expect(
      hostConfig.prepareUpdate(
        box,
        'ink-box',
        { id: 'box', style: { paddingLeft: 1 } },
        { id: 'box2', style: { paddingLeft: 2 } },
      ),
    ).toMatchObject({
      props: { id: 'box2' },
      style: { paddingLeft: 2 },
      nextStyle: { paddingLeft: 2 },
    })
    expect(
      hostConfig.prepareUpdate(
        box,
        'ink-box',
        { id: 'box2' },
        { id: 'box2', style: { paddingLeft: 3 } },
      ),
    ).toMatchObject({
      props: undefined,
      style: { paddingLeft: 3 },
      nextStyle: { paddingLeft: 3 },
    })

    const nextClick = vi.fn()
    hostConfig.commitUpdate(
      box,
      'ink-box',
      {
        id: 'box',
        style: { paddingLeft: 1 },
        textStyles: { bold: true },
        onClick,
      },
      {
        id: 'box2',
        style: { paddingLeft: 2 },
        textStyles: { italic: true },
        onClick: nextClick,
      },
    )

    expect(box.attributes.id).toBe('box2')
    expect(box.style).toMatchObject({ paddingLeft: 2 })
    expect(box.textStyles).toEqual({ italic: true })
    expect(box._eventHandlers?.onClick).toBe(nextClick)

    hostConfig.commitUpdate(
      box,
      'ink-box',
      {
        title: 'old title',
        textStyles: { italic: true },
      },
      {
        title: 'new title',
        textStyles: { underline: true },
      },
    )
    expect(box.attributes.title).toBe('new title')
    expect(box.textStyles).toEqual({ underline: true })

    const link = hostConfig.createInstance(
      'ink-link',
      { style: { flexGrow: 0 } },
      root,
      rootContext,
    )
    expect(link.yogaNode).toBeUndefined()
    hostConfig.commitUpdate(
      link,
      'ink-link',
      { style: { flexGrow: 0 } },
      { style: { flexGrow: 1 } },
    )
    expect(link.style).toEqual({ flexGrow: 1 })

    const hostChild = hostConfig.createInstance(
      'ink-box',
      { id: 'host-child' },
      root,
      rootContext,
    )
    hostConfig.appendChild(root, hostChild)
    const handleNodeRemoved = vi.spyOn(root.focusManager, 'handleNodeRemoved')

    hostConfig.removeChild(root, hostChild)
    expect(hostChild.parentNode).toBeUndefined()
    expect(hostChild.yogaNode).toBeUndefined()
    expect(handleNodeRemoved).toHaveBeenCalledWith(hostChild, root)

    const textChild = hostConfig.createTextInstance('remove me', root, rootContext)
    hostConfig.appendChild(root, textChild)
    handleNodeRemoved.mockClear()
    hostConfig.removeChild(root, textChild)
    expect(textChild.parentNode).toBeUndefined()
    expect(handleNodeRemoved).not.toHaveBeenCalled()

    const containerChild = hostConfig.createInstance(
      'ink-box',
      { id: 'container-child' },
      root,
      rootContext,
    )
    hostConfig.appendChildToContainer(root, containerChild)
    hostConfig.removeChildFromContainer(root, containerChild)
    expect(containerChild.parentNode).toBeUndefined()
    expect(containerChild.yogaNode).toBeUndefined()
    expect(handleNodeRemoved).toHaveBeenCalledWith(containerChild, root)

    expect(hostConfig.maySuspendCommit()).toBe(false)
    expect(hostConfig.preloadInstance()).toBe(true)
    hostConfig.startSuspendingCommit()
    hostConfig.suspendInstance()
    expect(hostConfig.waitForCommitToBeReady()).toBeNull()
    expect(hostConfig.NotPendingTransition).toBeNull()
    expect(hostConfig.HostTransitionContext.$$typeof).toBe(
      Symbol.for('react.context'),
    )
    expect(hostConfig.HostTransitionContext._currentValue).toBeNull()
    hostConfig.beforeActiveInstanceBlur()
    hostConfig.afterActiveInstanceBlur()
    hostConfig.detachDeletedInstance()
    expect(hostConfig.getInstanceFromNode()).toBeNull()
    hostConfig.prepareScopeUpdate()
    expect(hostConfig.getInstanceFromScope()).toBeNull()
    hostConfig.resetFormInstance()
    hostConfig.requestPostPaintCallback()
    expect(hostConfig.shouldAttemptEagerTransition()).toBe(false)
    hostConfig.trackSchedulerEvent()

    hostConfig.setCurrentUpdatePriority(123)
    expect(hostConfig.getCurrentUpdatePriority()).toBe(123)
    expect(hostConfig.resolveUpdatePriority()).toBe(123)

    module.dispatcher.currentUpdatePriority = 0
    module.dispatcher.currentEvent = {
      type: 'scroll',
      timeStamp: 456,
    } as never
    expect(hostConfig.resolveEventType()).toBe('scroll')
    expect(hostConfig.resolveEventTimeStamp()).toBe(456)
    expect(hostConfig.resolveUpdatePriority()).toBeGreaterThan(0)

    module.dispatcher.currentEvent = null
    expect(hostConfig.resolveEventType()).toBeNull()
    expect(hostConfig.resolveEventTimeStamp()).toBe(-1.1)

    expect(
      module.dispatcher.discreteUpdates?.(
        (left: number, right: number) => left + right,
        2,
        3,
        undefined,
        undefined,
      ),
    ).toBe(5)
    expect(fakeReconciler.discreteUpdates).toHaveBeenCalled()
  } finally {
    if (previousDebugRepaints === undefined) {
      delete process.env.AGENC_DEBUG_REPAINTS
    } else {
      process.env.AGENC_DEBUG_REPAINTS = previousDebugRepaints
    }
  }
})

test('host config resetAfterCommit routes production rendering and commit logging', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCommitLog = process.env.AGENC_COMMIT_LOG
  const tempDir = mkdtempSync(join(tmpdir(), 'agenc-reconciler-'))
  const logPath = join(tempDir, 'commit.log')

  process.env.NODE_ENV = 'production'
  process.env.AGENC_COMMIT_LOG = logPath

  try {
    const { hostConfig, module, dom } = await importHostConfig()
    const now = vi.spyOn(performance, 'now')
    now
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(1035)
      .mockReturnValueOnce(1040)
      .mockReturnValueOnce(1065)
      .mockReturnValueOnce(1070)
      .mockReturnValueOnce(1095)
      .mockReturnValueOnce(1100)
      .mockReturnValueOnce(1115)

    const root = dom.createNode('ink-root')
    root.onComputeLayout = vi.fn()
    root.onRender = vi.fn()
    root.onImmediateRender = vi.fn()

    module.markCommitStart()
    expect(hostConfig.prepareForCommit()).toBeNull()
    hostConfig.createInstance('ink-box', {}, root, { isInsideText: false })
    hostConfig.resetAfterCommit(root)

    expect(root.onComputeLayout).toHaveBeenCalledTimes(1)
    expect(root.onRender).toHaveBeenCalledTimes(1)
    expect(root.onImmediateRender).not.toHaveBeenCalled()
    expect(module.getLastCommitMs()).toBeGreaterThanOrEqual(0)

    const commitLog = readFileSync(logPath, 'utf8')
    expect(commitLog).toContain('reconcile=30.0ms')
    expect(commitLog).toContain('commits=1/s')
    expect(commitLog).toContain('SLOW_YOGA 25.0ms')
    expect(commitLog).toContain('SLOW_PAINT 15.0ms')

    now
      .mockReturnValueOnce(1200)
      .mockReturnValueOnce(1205)
      .mockReturnValueOnce(1250)
      .mockReturnValueOnce(1260)
      .mockReturnValueOnce(1265)

    root.onComputeLayout = undefined
    hostConfig.prepareForCommit()
    hostConfig.resetAfterCommit(root)

    const updatedLog = readFileSync(logPath, 'utf8')
    expect(updatedLog).toContain('gap=140.0ms')
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
    if (previousCommitLog === undefined) {
      delete process.env.AGENC_COMMIT_LOG
    } else {
      process.env.AGENC_COMMIT_LOG = previousCommitLog
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
})

test('host config resetAfterCommit handles quiet test and production commits', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCommitLog = process.env.AGENC_COMMIT_LOG

  delete process.env.AGENC_COMMIT_LOG

  try {
    const { hostConfig, dom } = await importHostConfig()
    const root = dom.createNode('ink-root')
    root.onImmediateRender = vi.fn()

    process.env.NODE_ENV = 'test'
    hostConfig.resetAfterCommit(root)

    expect(root.hasRenderedContent).toBeUndefined()
    expect(root.onImmediateRender).toHaveBeenCalledTimes(1)

    root.onRender = vi.fn()
    process.env.NODE_ENV = 'production'
    hostConfig.resetAfterCommit(root)

    expect(root.onRender).toHaveBeenCalledTimes(1)
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
    if (previousCommitLog === undefined) {
      delete process.env.AGENC_COMMIT_LOG
    } else {
      process.env.AGENC_COMMIT_LOG = previousCommitLog
    }
  }
})

test('host config commit logging skips detail rows for quiet commits', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  const previousCommitLog = process.env.AGENC_COMMIT_LOG
  const tempDir = mkdtempSync(join(tmpdir(), 'agenc-reconciler-quiet-'))
  const logPath = join(tempDir, 'commit.log')

  process.env.NODE_ENV = 'production'
  process.env.AGENC_COMMIT_LOG = logPath

  try {
    const { hostConfig, dom } = await importHostConfig()
    const now = vi.spyOn(performance, 'now')
    now
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(20)
      .mockReturnValueOnce(30)
      .mockReturnValueOnce(40)
      .mockReturnValueOnce(50)

    const root = dom.createNode('ink-root')
    root.onRender = vi.fn()

    hostConfig.resetAfterCommit(root)

    expect(root.onRender).toHaveBeenCalledTimes(1)
    expect(existsSync(logPath)).toBe(false)
  } finally {
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
    if (previousCommitLog === undefined) {
      delete process.env.AGENC_COMMIT_LOG
    } else {
      process.env.AGENC_COMMIT_LOG = previousCommitLog
    }
    rmSync(tempDir, { recursive: true, force: true })
  }
})
