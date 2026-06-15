import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { transformSync } from 'esbuild'
import React from 'react'
import { describe, expect, test, vi } from 'vitest'

const sourcePath = new URL(
  '../../../src/tui/cost/MemoryUsageIndicator.tsx',
  import.meta.url,
)

const mockUseMemoryUsage = vi.hoisted(() => vi.fn())

vi.mock('../../../src/tui/hooks/useMemoryUsage.js', () => ({
  useMemoryUsage: mockUseMemoryUsage,
}))

import { MemoryUsageIndicator } from '../../../src/tui/cost/MemoryUsageIndicator.js'

type MemoryUsageInfo = {
  heapUsed: number
  status: 'critical' | 'high' | 'normal'
}

type MemoryUsageComponent = () => React.ReactNode

type TextElementProps = {
  children?: React.ReactNode
  color?: string
  wrap?: string
}

function Box({ children }: { children?: React.ReactNode }): React.ReactElement {
  return React.createElement('box', null, children)
}

function Text(props: TextElementProps): React.ReactElement {
  return React.createElement('text', props, props.children)
}

function loadInternalBuildComponent({
  formatFileSize,
  useMemoryUsage,
}: {
  formatFileSize: (bytes: number) => string
  useMemoryUsage: () => MemoryUsageInfo | null
}): MemoryUsageComponent {
  const externalSource = readFileSync(sourcePath, 'utf8')
  const internalSource = externalSource.replace(
    `if (("external" as string) !== 'ant') {`,
    `if (("ant" as string) !== 'ant') {`,
  )

  if (internalSource === externalSource) {
    throw new Error('MemoryUsageIndicator build-time guard was not found')
  }

  const transformed = transformSync(internalSource, {
    format: 'cjs',
    jsx: 'transform',
    jsxFactory: 'React.createElement',
    jsxFragment: 'React.Fragment',
    loader: 'tsx',
    sourcefile: sourcePath.pathname,
    sourcemap: 'inline',
  })

  const module = { exports: {} as Record<string, unknown> }
  const context = {
    exports: module.exports,
    module,
    require: (specifier: string): unknown => {
      switch (specifier) {
        case 'react':
          return React
        case '../hooks/useMemoryUsage.js':
          return { useMemoryUsage }
        case '../ink.js':
          return { Box, Text }
        case '../../utils/format.js':
          return { formatFileSize }
        default:
          throw new Error(`Unexpected import from transformed source: ${specifier}`)
      }
    },
  }

  vm.runInNewContext(transformed.code, context, {
    filename: sourcePath.pathname,
  })

  return module.exports.MemoryUsageIndicator as MemoryUsageComponent
}

function getTextElement(node: React.ReactNode): React.ReactElement<TextElementProps> {
  if (!React.isValidElement(node)) {
    throw new Error('expected MemoryUsageIndicator to return an element')
  }

  const child = React.Children.only(node.props.children)
  if (!React.isValidElement<TextElementProps>(child)) {
    throw new Error('expected MemoryUsageIndicator to render text')
  }
  return child
}

function textContent(node: React.ReactNode): string {
  return React.Children.toArray(node).join('')
}

describe('MemoryUsageIndicator coverage swarm 128', () => {
  test('returns null before subscribing in external builds', () => {
    mockUseMemoryUsage.mockReturnValue({
      heapUsed: 3 * 1024 * 1024 * 1024,
      status: 'critical',
    })

    expect(MemoryUsageIndicator()).toBeNull()
    expect(mockUseMemoryUsage).not.toHaveBeenCalled()
  })

  test('suppresses empty and normal memory usage in the internal build path', () => {
    const formatFileSize = vi.fn((bytes: number) => `${bytes} bytes`)
    const useMemoryUsage = vi.fn<() => MemoryUsageInfo | null>(() => null)
    const Component = loadInternalBuildComponent({ formatFileSize, useMemoryUsage })

    expect(Component()).toBeNull()
    expect(useMemoryUsage).toHaveBeenCalledOnce()
    expect(formatFileSize).not.toHaveBeenCalled()

    useMemoryUsage.mockReturnValue({
      heapUsed: 1024,
      status: 'normal',
    })

    expect(Component()).toBeNull()
    expect(useMemoryUsage).toHaveBeenCalledTimes(2)
    expect(formatFileSize).not.toHaveBeenCalled()
  })

  test('renders high and critical memory warnings in the internal build path', () => {
    const formatFileSize = vi.fn((bytes: number) => `${bytes / 1024}KB`)
    const useMemoryUsage = vi.fn<() => MemoryUsageInfo | null>()
    const Component = loadInternalBuildComponent({ formatFileSize, useMemoryUsage })

    useMemoryUsage.mockReturnValue({
      heapUsed: 1536,
      status: 'high',
    })

    const highText = getTextElement(Component())
    expect(highText.props.color).toBe('warning')
    expect(highText.props.wrap).toBe('truncate')
    expect(textContent(highText.props.children)).toBe(
      'High memory usage (1.5KB) · /heapdump',
    )
    expect(formatFileSize).toHaveBeenLastCalledWith(1536)

    useMemoryUsage.mockReturnValue({
      heapUsed: 3072,
      status: 'critical',
    })

    const criticalText = getTextElement(Component())
    expect(criticalText.props.color).toBe('error')
    expect(criticalText.props.wrap).toBe('truncate')
    expect(textContent(criticalText.props.children)).toBe(
      'High memory usage (3KB) · /heapdump',
    )
    expect(formatFileSize).toHaveBeenLastCalledWith(3072)
  })
})
