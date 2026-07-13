import { PassThrough } from 'node:stream'

import React from 'react'
import stripAnsi from 'strip-ansi'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  ConfigScope,
  McpServerConfig,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import { createRoot } from '../ink/root.js'
import { renderToString } from '../../utils/staticRender.js'
import { MCPServerDesktopImportDialog } from './MCPServerDesktopImportDialog.js'

type SelectOption = {
  label: string
  value: string
}

type CapturedSelectMultiProps = {
  options: SelectOption[]
  defaultValue?: string[]
  onSubmit?: (values: string[]) => Promise<void>
  onCancel: () => void
  hideIndexes?: boolean
}

type CapturedDialogProps = {
  title: React.ReactNode
  subtitle?: React.ReactNode
  children: React.ReactNode
  onCancel: () => void
  color?: string
  hideInputGuide?: boolean
}

const harness = vi.hoisted(() => ({
  addMcpConfig: vi.fn(),
  dialogProps: undefined as CapturedDialogProps | undefined,
  getAllMcpConfigs: vi.fn(),
  gracefulShutdown: vi.fn(),
  logError: vi.fn(),
  selectProps: undefined as CapturedSelectMultiProps | undefined,
  writeToStdout: vi.fn(),
}))

vi.mock('../../services/mcp/config.js', () => ({
  addMcpConfig: harness.addMcpConfig,
  getAllMcpConfigs: harness.getAllMcpConfigs,
}))

vi.mock('../../utils/gracefulShutdown.js', () => ({
  gracefulShutdown: harness.gracefulShutdown,
}))

vi.mock('../../utils/log.js', () => ({
  logError: harness.logError,
}))

vi.mock('src/utils/process.js', () => ({
  writeToStdout: harness.writeToStdout,
}))

vi.mock('./design-system/Dialog.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    Dialog: (props: CapturedDialogProps) => {
      harness.dialogProps = props
      return ReactActual.createElement(
        ReactActual.Fragment,
        null,
        ReactActual.createElement('ink-text', null, String(props.title)),
        props.subtitle
          ? ReactActual.createElement('ink-text', null, String(props.subtitle))
          : null,
        props.children,
      )
    },
  }
})

vi.mock('./CustomSelect/SelectMulti.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    SelectMulti: (props: CapturedSelectMultiProps) => {
      harness.selectProps = props
      return ReactActual.createElement(
        'ink-text',
        null,
        props.options.map(option => option.label).join('\n'),
      )
    },
  }
})

const DESKTOP_SERVERS = {
  filesystem: { type: 'stdio', command: 'node', args: ['fs-server.js'] },
  docs: { type: 'http', url: 'https://docs.example.test/mcp' },
} satisfies Record<string, McpServerConfig>

function scoped(
  config: McpServerConfig,
  scope: ConfigScope = 'user',
): ScopedMcpServerConfig {
  return { ...config, scope }
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
  ;(stdout as unknown as { columns: number; rows: number }).columns = 120
  ;(stdout as unknown as { columns: number; rows: number }).rows = 30
  stdout.resume()

  return { stdin, stdout }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) return
    await sleep(10)
  }
  throw new Error(message)
}

function selectProps(): CapturedSelectMultiProps {
  if (!harness.selectProps) {
    throw new Error('SelectMulti props were not captured')
  }
  return harness.selectProps
}

function dialogProps(): CapturedDialogProps {
  if (!harness.dialogProps) {
    throw new Error('Dialog props were not captured')
  }
  return harness.dialogProps
}

async function renderDialog({
  servers = DESKTOP_SERVERS,
  existingServers = {},
  scope = 'user',
}: {
  servers?: Record<string, McpServerConfig>
  existingServers?: Record<string, ScopedMcpServerConfig>
  scope?: ConfigScope
} = {}) {
  harness.getAllMcpConfigs.mockResolvedValue({ servers: existingServers })

  const onDone = vi.fn()
  const { stdin, stdout } = createStreams()
  const root = await createRoot({
    patchConsole: false,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
  })

  root.render(
    <MCPServerDesktopImportDialog
      servers={servers}
      scope={scope}
      onDone={onDone}
    />,
  )
  await waitFor(
    () => harness.selectProps !== undefined && harness.dialogProps !== undefined,
    'MCP server import dialog did not render',
  )

  return {
    onDone,
    dispose: async () => {
      root.unmount()
      stdin.end()
      stdout.end()
      await sleep(20)
    },
  }
}

describe('MCPServerDesktopImportDialog', () => {
  beforeEach(() => {
    harness.addMcpConfig.mockReset()
    harness.addMcpConfig.mockResolvedValue(undefined)
    harness.dialogProps = undefined
    harness.getAllMcpConfigs.mockReset()
    harness.gracefulShutdown.mockReset()
    harness.logError.mockReset()
    harness.selectProps = undefined
    harness.writeToStdout.mockReset()
  })

  it('renders the empty desktop state and cancels as a no-op import', async () => {
    const rendered = await renderDialog({ servers: {} })

    try {
      expect(dialogProps().title).toBe('Import MCP Servers from AgenC Desktop')
      expect(dialogProps().subtitle).toBe(
        'Found 0 MCP servers in AgenC Desktop.',
      )
      expect(dialogProps().color).toBe('success')
      expect(dialogProps().hideInputGuide).toBe(true)
      expect(selectProps().options).toEqual([])
      expect(selectProps().defaultValue).toEqual([])
      expect(selectProps().hideIndexes).toBe(true)

      selectProps().onCancel()

      expect(harness.addMcpConfig).not.toHaveBeenCalled()
      expect(harness.writeToStdout).toHaveBeenCalledWith(
        '\nNo servers were imported.',
      )
      expect(rendered.onDone).toHaveBeenCalledOnce()
      expect(harness.gracefulShutdown).toHaveBeenCalledOnce()
    } finally {
      await rendered.dispose()
    }
  })

  it('renders collisions after loading existing configs and excludes them from the default selection', async () => {
    const rendered = await renderDialog({
      existingServers: {
        docs: scoped(DESKTOP_SERVERS.docs),
        docs_1: scoped(DESKTOP_SERVERS.docs),
      },
    })

    try {
      await waitFor(
        () =>
          selectProps().options.some(
            option => option.label === 'docs (already exists)',
          ),
        'MCP server import dialog did not render collision state',
      )

      expect(selectProps().options).toEqual([
        { label: 'filesystem', value: 'filesystem' },
        { label: 'docs (already exists)', value: 'docs' },
      ])
      expect(selectProps().defaultValue).toEqual(['filesystem'])

      const body = await renderToString(<>{dialogProps().children}</>, 120)
      expect(body).toContain('Note: Some servers already exist')
      expect(body).toContain('Please select the servers you want to import')
      expect(body).toContain('docs (already exists)')
    } finally {
      await rendered.dispose()
    }
  })

  it('logs rejected existing config reads and keeps all imports selectable', async () => {
    const error = new Error('config read failed')
    harness.getAllMcpConfigs.mockRejectedValueOnce(error)
    const rendered = await renderDialog()

    try {
      await waitFor(
        () => harness.getAllMcpConfigs.mock.calls.length > 0,
        'MCP server import dialog did not try to load existing server names',
      )
      await sleep(20)

      expect(harness.logError).toHaveBeenCalledWith(error)
      expect(selectProps().options).toEqual([
        { label: 'filesystem', value: 'filesystem' },
        { label: 'docs', value: 'docs' },
      ])
      expect(selectProps().defaultValue).toEqual(['filesystem', 'docs'])
    } finally {
      await rendered.dispose()
    }
  })

  it('imports selected servers, suffixes collisions, and writes the success result', async () => {
    const rendered = await renderDialog({
      existingServers: {
        docs: scoped(DESKTOP_SERVERS.docs),
        docs_1: scoped(DESKTOP_SERVERS.docs),
      },
      scope: 'project',
    })

    try {
      await waitFor(
        () =>
          selectProps().options.some(
            option => option.label === 'docs (already exists)',
          ),
        'MCP server import dialog did not load existing server names',
      )

      await selectProps().onSubmit?.(['docs', 'filesystem'])

      expect(harness.addMcpConfig).toHaveBeenNthCalledWith(
        1,
        'docs_2',
        DESKTOP_SERVERS.docs,
        'project',
      )
      expect(harness.addMcpConfig).toHaveBeenNthCalledWith(
        2,
        'filesystem',
        DESKTOP_SERVERS.filesystem,
        'project',
      )
      expect(stripAnsi(harness.writeToStdout.mock.calls[0]?.[0] ?? '')).toContain(
        'Successfully imported 2 MCP servers to project config.',
      )
      expect(rendered.onDone).toHaveBeenCalledOnce()
      expect(harness.gracefulShutdown).toHaveBeenCalledOnce()
    } finally {
      await rendered.dispose()
    }
  })

  it('ignores stale selected names and reports that nothing was imported', async () => {
    const rendered = await renderDialog()

    try {
      await selectProps().onSubmit?.(['missing-server'])

      expect(harness.addMcpConfig).not.toHaveBeenCalled()
      expect(harness.writeToStdout).toHaveBeenCalledWith(
        '\nNo servers were imported.',
      )
      expect(rendered.onDone).toHaveBeenCalledOnce()
      expect(harness.gracefulShutdown).toHaveBeenCalledOnce()
    } finally {
      await rendered.dispose()
    }
  })

  it('catches import errors without completing or shutting down', async () => {
    harness.addMcpConfig.mockRejectedValueOnce(new Error('write failed'))
    const rendered = await renderDialog()

    try {
      // onSubmit is invoked fire-and-forget by SelectMulti, so it must catch the
      // failed write (no unhandled rejection) — but it must NOT complete or shut
      // down as if the import succeeded. The dialog stays open; the error is logged.
      await expect(selectProps().onSubmit?.(['filesystem'])).resolves.toBeUndefined()

      expect(harness.logError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'write failed' }),
      )
      expect(harness.writeToStdout).not.toHaveBeenCalled()
      expect(rendered.onDone).not.toHaveBeenCalled()
      expect(harness.gracefulShutdown).not.toHaveBeenCalled()
    } finally {
      await rendered.dispose()
    }
  })
})
