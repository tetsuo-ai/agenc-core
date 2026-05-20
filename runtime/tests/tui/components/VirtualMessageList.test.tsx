import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const virtualScroll = vi.hoisted(() => ({
  bottomSpacer: 0,
  elements: new Map<number, unknown>(),
  heights: new Map<number, number | undefined>(),
  itemTops: new Map<number, number>(),
  keys: [] as readonly string[],
  offsets: [] as number[],
  range: [0, 0] as [number, number],
  reset() {
    virtualScroll.bottomSpacer = 0
    virtualScroll.elements = new Map()
    virtualScroll.heights = new Map()
    virtualScroll.itemTops = new Map()
    virtualScroll.keys = []
    virtualScroll.offsets = []
    virtualScroll.range = [0, 0]
    virtualScroll.scrollToIndex.mockClear()
    virtualScroll.topSpacer = 0
  },
  scrollToIndex: vi.fn(),
  topSpacer: 0,
}))

vi.mock('../hooks/useVirtualScroll.js', () => ({
  useVirtualScroll: (_scrollRef: unknown, keys: readonly string[]) => {
    virtualScroll.keys = keys
    return {
      bottomSpacer: virtualScroll.bottomSpacer,
      getItemElement: (index: number) =>
        virtualScroll.elements.get(index) ?? null,
      getItemHeight: (index: number) => virtualScroll.heights.get(index),
      getItemTop: (index: number) => virtualScroll.itemTops.get(index) ?? -1,
      measureRef: (key: string) => (el: unknown) => {
        const index = virtualScroll.keys.indexOf(key)
        if (index >= 0 && el) virtualScroll.elements.set(index, el)
      },
      offsets: virtualScroll.offsets,
      range: virtualScroll.range,
      scrollToIndex: virtualScroll.scrollToIndex,
      spacerRef: { current: null },
      topSpacer: virtualScroll.topSpacer,
    }
  },
}))

vi.mock('../../utils/sleep.js', () => ({
  sleep: async () => {},
}))

import { createRoot } from '../ink/root.js'
import { Text } from '../ink.js'
import type { ScrollBoxHandle } from '../ink/components/ScrollBox.js'
import type { DOMElement } from '../ink/dom.js'
import type { RenderableMessage } from '../../types/message.js'
import { ScrollChromeContext } from './FullscreenLayout.js'
import {
  type JumpHandle,
  VirtualMessageList,
} from './VirtualMessageList.js'
import type {
  MessageActionsNav,
  MessageActionsState,
} from './messageActions.js'

type TestScrollHandle = ScrollBoxHandle & {
  emit: () => void
  setPendingDelta: (value: number) => void
  setSticky: (value: boolean) => void
}

function userMessage(
  uuid: string,
  text: string,
  overrides: Partial<RenderableMessage> = {},
): RenderableMessage {
  return {
    isCompactSummary: false,
    isMeta: false,
    isVisibleInTranscriptOnly: false,
    message: { content: [{ text, type: 'text' }] },
    type: 'user',
    uuid,
    ...overrides,
  } as RenderableMessage
}

function assistantMessage(uuid: string, text: string): RenderableMessage {
  return {
    message: { content: [{ text, type: 'text' }] },
    type: 'assistant',
    uuid,
  } as RenderableMessage
}

function systemMessage(uuid: string, subtype = 'note'): RenderableMessage {
  return {
    subtype,
    type: 'system',
    uuid,
  } as RenderableMessage
}

function queuedCommand(
  uuid: string,
  prompt: string | Array<{ type: string; text?: string }>,
): RenderableMessage {
  return {
    attachment: {
      commandMode: 'prompt',
      isMeta: false,
      prompt,
      type: 'queued_command',
    },
    type: 'attachment',
    uuid,
  } as RenderableMessage
}

function fakeElement(height = 2): DOMElement {
  return {
    yogaNode: {
      getComputedHeight: () => height,
    },
  } as DOMElement
}

function createScrollHandle(initialScrollTop = 0): TestScrollHandle {
  let scrollTop = initialScrollTop
  let pendingDelta = 0
  let sticky = false
  const listeners = new Set<() => void>()
  return {
    emit: () => {
      for (const listener of listeners) listener()
    },
    getPendingDelta: vi.fn(() => pendingDelta),
    getScrollTop: vi.fn(() => scrollTop),
    getViewportHeight: vi.fn(() => 10),
    getViewportTop: vi.fn(() => 0),
    isSticky: vi.fn(() => sticky),
    scrollTo: vi.fn((value: number) => {
      scrollTop = value
    }),
    scrollToBottom: vi.fn(() => {
      sticky = true
    }),
    scrollToElement: vi.fn(),
    setPendingDelta: (value: number) => {
      pendingDelta = value
    },
    setSticky: (value: boolean) => {
      sticky = value
    },
    subscribe: vi.fn((listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
  } as unknown as TestScrollHandle
}

function createStreams(): {
  stdout: PassThrough
  stdin: PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
} {
  const stdout = new PassThrough()
  const stdin = new PassThrough() as PassThrough & {
    isTTY: boolean
    ref: () => void
    setRawMode: (mode: boolean) => void
    unref: () => void
  }
  stdin.isTTY = true
  stdin.ref = () => {}
  stdin.setRawMode = () => {}
  stdin.unref = () => {}
  stdout.resume()
  return { stdin, stdout }
}

async function sleep(ms = 25): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms))
}

async function renderList({
  cursorNavRef,
  extractSearchText,
  isItemClickable,
  isItemExpanded,
  itemKey = msg => msg.uuid,
  jumpRef,
  messages,
  onItemClick,
  onSearchMatchesChange,
  scanElement,
  scrollHandle = createScrollHandle(),
  selectedIndex,
  setCursor,
  setPositions,
  setStickyPrompt,
  trackStickyPrompt = false,
}: {
  cursorNavRef?: React.RefObject<MessageActionsNav | null>
  extractSearchText?: (msg: RenderableMessage) => string
  isItemClickable?: (msg: RenderableMessage) => boolean
  isItemExpanded?: (msg: RenderableMessage) => boolean
  itemKey?: (msg: RenderableMessage) => string
  jumpRef?: React.RefObject<JumpHandle | null>
  messages: RenderableMessage[]
  onItemClick?: (msg: RenderableMessage) => void
  onSearchMatchesChange?: (count: number, current: number) => void
  scanElement?: (el: DOMElement) => Array<{ row: number; col: number }>
  scrollHandle?: TestScrollHandle
  selectedIndex?: number
  setCursor?: (cursor: MessageActionsState | null) => void
  setPositions?: (
    state: {
      positions: Array<{ row: number; col: number }>
      rowOffset: number
      currentIdx: number
    } | null,
  ) => void
  setStickyPrompt?: React.ComponentProps<
    typeof ScrollChromeContext
  >['value']['setStickyPrompt']
  trackStickyPrompt?: boolean
}): Promise<{
  dispose: () => Promise<void>
  output: () => string
  scrollHandle: TestScrollHandle
}> {
  let output = ''
  const { stdin, stdout } = createStreams()
  stdout.on('data', chunk => {
    output += chunk.toString()
  })
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })
  const scrollRef = {
    current: scrollHandle,
  } as React.RefObject<ScrollBoxHandle | null>
  const node = (
    <ScrollChromeContext
      value={{ setStickyPrompt: setStickyPrompt ?? (() => {}) }}
    >
      <VirtualMessageList
        columns={80}
        cursorNavRef={cursorNavRef}
        extractSearchText={extractSearchText}
        isItemClickable={isItemClickable}
        isItemExpanded={isItemExpanded}
        itemKey={itemKey}
        jumpRef={jumpRef}
        messages={messages}
        onItemClick={onItemClick}
        onSearchMatchesChange={onSearchMatchesChange}
        renderItem={(msg, index) => (
          <Text>
            {index}:{msg.uuid}
          </Text>
        )}
        scanElement={scanElement}
        scrollRef={scrollRef}
        selectedIndex={selectedIndex}
        setCursor={setCursor}
        setPositions={setPositions}
        trackStickyPrompt={trackStickyPrompt}
      />
    </ScrollChromeContext>
  )
  root.render(node)
  await sleep()
  return {
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep()
    },
    output: () => stripAnsi(output),
    scrollHandle,
  }
}

describe('VirtualMessageList', () => {
  beforeEach(() => {
    virtualScroll.reset()
  })

  afterEach(() => {
    virtualScroll.reset()
  })

  test('renders only the virtualized range with spacers', async () => {
    const messages = [
      userMessage('u-1', 'first prompt'),
      assistantMessage('a-1', 'assistant reply'),
      queuedCommand('q-1', 'queued prompt'),
    ]
    virtualScroll.range = [1, 3]
    virtualScroll.topSpacer = 2
    virtualScroll.bottomSpacer = 4
    virtualScroll.offsets = [0, 2, 4, 6]
    for (let i = 0; i < messages.length; i++) {
      virtualScroll.heights.set(i, 1)
      virtualScroll.itemTops.set(i, i * 2)
    }

    const rendered = await renderList({
      isItemClickable: msg => msg.type !== 'attachment',
      isItemExpanded: msg => msg.uuid === 'a-1',
      messages,
      onItemClick: vi.fn(),
    })

    try {
      expect(rendered.output()).not.toContain('0:u-1')
      expect(rendered.output()).toContain('1:a-1')
      expect(rendered.output()).toContain('2:q-1')
      expect(virtualScroll.keys).toEqual(['u-1', 'a-1', 'q-1'])
    } finally {
      await rendered.dispose()
    }
  })

  test('exposes cursor navigation over visible navigable messages', async () => {
    const messages = [
      userMessage('meta', 'hidden', { isMeta: true } as Partial<RenderableMessage>),
      userMessage('u-1', 'first prompt'),
      systemMessage('metrics', 'api_metrics'),
      assistantMessage('a-1', 'needle reply'),
      userMessage('xml', '<command-message>synthetic</command-message>'),
    ]
    virtualScroll.range = [0, messages.length]
    virtualScroll.offsets = [0, 2, 4, 6, 8, 10]
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, index === 2 ? 0 : 1)
      virtualScroll.itemTops.set(index, index * 2)
      virtualScroll.elements.set(index, fakeElement())
    })
    const navRef = React.createRef<MessageActionsNav | null>()
    const setCursor = vi.fn()
    const scrollHandle = createScrollHandle()

    const rendered = await renderList({
      cursorNavRef: navRef,
      messages,
      scrollHandle,
      selectedIndex: 3,
      setCursor,
    })

    try {
      navRef.current?.enterCursor()
      expect(setCursor).toHaveBeenLastCalledWith({
        expanded: false,
        msgType: 'user',
        toolName: undefined,
        uuid: 'u-1',
      })

      navRef.current?.navigatePrev()
      expect(setCursor).toHaveBeenLastCalledWith({
        expanded: false,
        msgType: 'user',
        toolName: undefined,
        uuid: 'u-1',
      })

      navRef.current?.navigateNext()
      expect(scrollHandle.scrollToBottom).toHaveBeenCalled()
      expect(setCursor).toHaveBeenLastCalledWith(null)

      navRef.current?.navigateTop()
      expect(setCursor).toHaveBeenLastCalledWith({
        expanded: false,
        msgType: 'user',
        toolName: undefined,
        uuid: 'u-1',
      })
      expect(navRef.current?.getSelected()).toBe(messages[3])
    } finally {
      await rendered.dispose()
    }
  })

  test('search jump handle scans, highlights, steps, disarms, and warms the search index', async () => {
    const messages = [
      userMessage('u-1', 'alpha needle'),
      assistantMessage('a-1', 'needle and another needle'),
      queuedCommand('q-1', [
        { text: 'queued needle', type: 'text' },
        { type: 'image' },
      ]),
    ]
    virtualScroll.range = [0, messages.length]
    virtualScroll.offsets = [0, 10, 20, 30]
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 2)
      virtualScroll.itemTops.set(index, index * 10)
      virtualScroll.elements.set(index, fakeElement(2))
    })
    const scrollHandle = createScrollHandle(11)
    const jumpRef = React.createRef<JumpHandle | null>()
    const setPositions = vi.fn()
    const onSearchMatchesChange = vi.fn()
    const scanElement = vi
      .fn()
      .mockReturnValueOnce([
        { col: 2, row: 0 },
        { col: 8, row: 5 },
      ])
      .mockReturnValue([{ col: 1, row: 1 }])

    const rendered = await renderList({
      extractSearchText: msg => {
        if (msg.type === 'user') return msg.message.content[0].text.toLowerCase()
        if (msg.type === 'assistant') {
          return msg.message.content[0].text.toLowerCase()
        }
        return 'queued needle'
      },
      jumpRef,
      messages,
      onSearchMatchesChange,
      scanElement,
      scrollHandle,
      setPositions,
    })

    try {
      jumpRef.current?.setAnchor()
      jumpRef.current?.setSearchQuery('needle')
      await sleep()

      expect(scrollHandle.scrollTo).toHaveBeenCalledWith(7)
      expect(scanElement).toHaveBeenCalled()
      expect(setPositions).toHaveBeenLastCalledWith({
        currentIdx: 1,
        positions: [
          { col: 2, row: 0 },
          { col: 8, row: 5 },
        ],
        rowOffset: 3,
      })
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith(4, 3)

      jumpRef.current?.nextMatch()
      await sleep()
      expect(setPositions).toHaveBeenLastCalledWith({
        currentIdx: 0,
        positions: [{ col: 1, row: 1 }],
        rowOffset: 3,
      })

      jumpRef.current?.disarmSearch()
      expect(setPositions).toHaveBeenLastCalledWith(null)

      jumpRef.current?.setSearchQuery('missing')
      expect(scrollHandle.scrollTo).toHaveBeenLastCalledWith(11)
      expect(onSearchMatchesChange).toHaveBeenLastCalledWith(0, 0)

      await expect(jumpRef.current?.warmSearchIndex()).resolves.toEqual(
        expect.any(Number),
      )
      await expect(jumpRef.current?.warmSearchIndex()).resolves.toBe(0)
    } finally {
      await rendered.dispose()
    }
  })

  test('tracks sticky prompts and jump-to-prompt correction paths', async () => {
    const stickyPrompts: unknown[] = []
    const messages = [
      userMessage(
        'u-1',
        '<system-reminder>ignore</system-reminder>\n\nsticky prompt\n\nsecond paragraph',
      ),
      assistantMessage('a-1', 'visible response'),
      queuedCommand('q-1', [
        { text: 'queued visible prompt', type: 'text' },
        { type: 'image' },
      ]),
    ]
    virtualScroll.range = [1, messages.length]
    virtualScroll.offsets = [0, 10, 20, 30]
    messages.forEach((_, index) => {
      virtualScroll.heights.set(index, 2)
      virtualScroll.itemTops.set(index, index * 10)
      if (index !== 0) virtualScroll.elements.set(index, fakeElement(2))
    })
    const scrollHandle = createScrollHandle(6)

    const rendered = await renderList({
      messages,
      scrollHandle,
      setStickyPrompt: prompt => stickyPrompts.push(prompt),
      trackStickyPrompt: true,
    })

    try {
      await sleep()
      const prompt = stickyPrompts.at(-1)
      expect(prompt).toMatchObject({ text: 'sticky prompt' })

      ;(prompt as { scrollTo: () => void }).scrollTo()
      expect(stickyPrompts.at(-1)).toBe('clicked')
      expect(scrollHandle.scrollTo).toHaveBeenCalledWith(0)

      virtualScroll.elements.set(0, fakeElement(2))
      scrollHandle.emit()
      await sleep()
      expect(scrollHandle.scrollToElement).toHaveBeenCalledWith(
        virtualScroll.elements.get(0),
        1,
      )
    } finally {
      await rendered.dispose()
    }
  })
})
