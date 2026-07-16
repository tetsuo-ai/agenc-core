import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'

import { describe, expect, test, vi } from 'vitest'

import {
  allowPermissionDecision,
  rejectPermissionDecision,
  XaiAcpClient,
  type XaiAcpPermissionRequest,
} from '../../../src/services/xai/acp.ts'
import { SandboxExecutionBroker } from '../../../src/sandbox/execution-broker.ts'
import { explicitDangerBroker } from '../../helpers/explicit-danger-boundary.ts'

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'fake-acp-agent.mjs',
)

function makeClient(options?: {
  env?: NodeJS.ProcessEnv
  onPermissionRequest?: (
    request: XaiAcpPermissionRequest,
  ) => { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' }
  requestTimeoutMs?: number
  promptTimeoutMs?: number
}): XaiAcpClient {
  return new XaiAcpClient({
    command: process.execPath,
    args: [FIXTURE],
    cwd: process.cwd(),
    env: { ...process.env, ...options?.env },
    sandboxExecutionBroker: explicitDangerBroker,
    ...(options?.onPermissionRequest !== undefined
      ? { onPermissionRequest: options.onPermissionRequest }
      : {}),
    ...(options?.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: options.requestTimeoutMs }
      : {}),
    ...(options?.promptTimeoutMs !== undefined
      ? { promptTimeoutMs: options.promptTimeoutMs }
      : {}),
  })
}

describe('XaiAcpClient', () => {
  test('initialize → authenticate → session → prompt with streamed chunks', async () => {
    const client = makeClient()
    try {
      const init = await client.initialize()
      expect(init.authMethods).toContain('cached_token')

      await client.authenticate('cached_token')

      const session = await client.newSession()
      expect(session.sessionId).toBe('mock-session-1')
      expect(session.currentModelId).toBe('grok-build')
      expect(session.availableModels.map(m => m.modelId)).toContain(
        'grok-composer-2.5-fast',
      )

      await client.setSessionModel(session.sessionId, 'grok-composer-2.5-fast')

      const chunks: string[] = []
      const result = await client.prompt({
        sessionId: session.sessionId,
        text: 'hi',
        onTextChunk: chunk => chunks.push(chunk),
      })
      expect(result.stopReason).toBe('end_turn')
      expect(result.text).toBe('[grok-composer-2.5-fast] Hello world')
      expect(chunks.length).toBeGreaterThanOrEqual(3)
    } finally {
      await client.dispose()
    }
  })

  test('permission requests reach the handler and the decision is applied', async () => {
    const seen: XaiAcpPermissionRequest[] = []
    const client = makeClient({
      env: { FAKE_ACP_REQUEST_PERMISSION: '1' },
      onPermissionRequest: request => {
        seen.push(request)
        return allowPermissionDecision(request)
      },
    })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      const result = await client.prompt({ sessionId: session.sessionId, text: 'hi' })
      expect(seen).toHaveLength(1)
      expect(seen[0].options.map(o => o.kind)).toEqual(['allow_once', 'reject_once'])
      expect(result.text).toContain('perm=selected:allow')
    } finally {
      await client.dispose()
    }
  })

  test('default permission policy rejects', async () => {
    const client = makeClient({ env: { FAKE_ACP_REQUEST_PERMISSION: '1' } })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      const result = await client.prompt({ sessionId: session.sessionId, text: 'hi' })
      expect(result.text).toContain('perm=selected:reject')
    } finally {
      await client.dispose()
    }
  })

  test('agent auth errors surface as typed agent_error', async () => {
    const client = makeClient({ env: { FAKE_ACP_FAIL_LOGIN: '1' } })
    try {
      await client.initialize()
      await expect(client.authenticate('cached_token')).rejects.toMatchObject({
        code: 'agent_error',
        rpcCode: -32000,
      })
    } finally {
      await client.dispose()
    }
  })

  test('missing binary fails at the executable boundary', async () => {
    expect(() =>
      new XaiAcpClient({
        command: 'definitely-not-a-real-grok-binary',
        cwd: process.cwd(),
        sandboxExecutionBroker: explicitDangerBroker,
      }),
    ).toThrowError(expect.objectContaining({
      code: 'sandbox_transform_failed',
      surface: 'provider',
    }))
  })

  test('prompt timeout produces a typed timeout error', async () => {
    const client = makeClient({
      env: { FAKE_ACP_STALL_PROMPT: '1' },
      promptTimeoutMs: 300,
    })
    try {
      await client.initialize()
      await client.authenticate('cached_token')
      const session = await client.newSession()
      await expect(
        client.prompt({ sessionId: session.sessionId, text: 'hi' }),
      ).rejects.toMatchObject({ code: 'timeout' })
    } finally {
      await client.dispose()
    }
  })

  test('required sandbox failure prevents the ACP executable from starting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-acp-boundary-'))
    const marker = join(root, 'spawned')
    const executable = join(root, 'grok.mjs')
    await writeFile(
      executable,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(marker)}, 'spawned')\n`,
      'utf8',
    )
    const broker = new SandboxExecutionBroker({
      mode: 'workspace_write',
      cwd: root,
      platform: 'linux',
      probe: () => ({
        kind: 'unavailable',
        mode: 'workspace_write',
        platform: 'linux',
        reason: 'probe: forced unavailable for ACP boundary test',
        remediation: 'repair the test sandbox',
      }),
    })

    try {
      expect(() =>
        new XaiAcpClient({
          command: process.execPath,
          args: [executable],
          cwd: root,
          sandboxExecutionBroker: broker,
        }),
      ).toThrowError(expect.objectContaining({
        code: 'sandbox_probe_failed',
        surface: 'provider',
      }))
      await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('restricted ACP grants network, scrubs unrelated secrets, and honors the transformed spawn', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agenc-acp-transform-'))
    const transformedCwd = join(root, 'transformed-cwd')
    const capturePath = join(root, 'spawn.json')
    const wrapperPath = join(root, 'transformed-agent.mjs')
    await mkdir(transformedCwd)
    await writeFile(
      wrapperPath,
      [
        'import { writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({`,
        '  cwd: process.cwd(),',
        '  argv0: process.argv0,',
        '  xaiApiKey: process.env.XAI_API_KEY ?? null,',
        '  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? null,',
        '  githubToken: process.env.GITHUB_TOKEN ?? null,',
        '  publicSetting: process.env.ACP_PUBLIC_SETTING ?? null,',
        '  transformed: process.env.ACP_TRANSFORMED ?? null,',
        '  referrer: process.env.GROK_OAUTH2_REFERRER ?? null,',
        '}))',
        `await import(${JSON.stringify(pathToFileURL(FIXTURE).href)})`,
      ].join('\n'),
      'utf8',
    )
    const broker = new SandboxExecutionBroker({
      mode: 'workspace_write',
      cwd: root,
      platform: 'linux',
      probe: () => ({
        kind: 'ready',
        mode: 'workspace_write',
        platform: 'linux',
      }),
    })
    const prepareSpawn = vi.spyOn(broker, 'prepareSpawn').mockImplementation(
      (_surface, command) => ({
        program: process.execPath,
        args: [wrapperPath],
        cwd: transformedCwd,
        env: { ...command.env, ACP_TRANSFORMED: 'present' },
        argv0: 'agenc-acp-sandboxed',
      }),
    )
    let client: XaiAcpClient | undefined

    try {
      client = new XaiAcpClient({
        command: 'untrusted-original-command',
        args: ['--must-not-run'],
        cwd: join(root, 'original-cwd'),
        env: {
          XAI_API_KEY: 'xai-preserved',
          ANTHROPIC_API_KEY: 'anthropic-must-be-scrubbed',
          GITHUB_TOKEN: 'github-must-be-scrubbed',
          ACP_PUBLIC_SETTING: 'public-preserved',
        },
        sandboxExecutionBroker: broker,
      })
      await client.initialize()

      expect(prepareSpawn).toHaveBeenCalledOnce()
      expect(prepareSpawn).toHaveBeenCalledWith('provider', {
        program: 'untrusted-original-command',
        args: ['--must-not-run'],
        cwd: root,
        env: {
          XAI_API_KEY: 'xai-preserved',
          ACP_PUBLIC_SETTING: 'public-preserved',
          GROK_OAUTH2_REFERRER: 'agenc',
        },
        additionalPermissions: { network: { enabled: true } },
      })
      expect(JSON.parse(await readFile(capturePath, 'utf8'))).toEqual({
        cwd: transformedCwd,
        argv0: 'agenc-acp-sandboxed',
        xaiApiKey: 'xai-preserved',
        anthropicApiKey: null,
        githubToken: null,
        publicSetting: 'public-preserved',
        transformed: 'present',
        referrer: 'agenc',
      })
    } finally {
      await client?.dispose()
      prepareSpawn.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform !== 'linux')(
    'dispose is bounded and kills a TERM-resistant ACP process tree',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agenc-acp-dispose-tree-'))
      const pidPath = join(root, 'pids.json')
      const agentPath = join(root, 'stubborn-agent.mjs')
      await writeFile(
        agentPath,
        [
          'import { spawn } from "node:child_process"',
          'import { writeFileSync } from "node:fs"',
          'const child = spawn(process.execPath, ["-e",',
          '  "process.on(\\"SIGTERM\\", () => {}); setInterval(() => {}, 1000)"',
          '], { stdio: "ignore" })',
          `writeFileSync(${JSON.stringify(pidPath)}, JSON.stringify({ agent: process.pid, child: child.pid }))`,
          'process.on("SIGTERM", () => {})',
          'setInterval(() => {}, 1000)',
        ].join('\n'),
        'utf8',
      )
      const broker = explicitDangerBroker.forkForCwd(root)
      let client: XaiAcpClient | undefined
      let pids: { agent: number; child: number } | undefined

      try {
        client = new XaiAcpClient({
          command: process.execPath,
          args: [agentPath],
          cwd: root,
          sandboxExecutionBroker: broker,
          terminateGraceMs: 50,
          settleBackstopMs: 500,
        })
        pids = JSON.parse(
          await waitForFile(pidPath, 2_000),
        ) as { agent: number; child: number }

        const startedAt = Date.now()
        await client.dispose()
        expect(Date.now() - startedAt).toBeLessThan(1_500)
        await expectProcessesStopped([pids.agent, pids.child], 2_000)
      } finally {
        await client?.dispose()
        if (pids !== undefined) {
          try {
            process.kill(-pids.agent, 'SIGKILL')
          } catch {
            // The tested process group has already stopped.
          }
        }
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})

async function waitForFile(path: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function expectProcessesStopped(
  pids: readonly number[],
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (
      (
        await Promise.all(pids.map(pid => isRunningNonZombie(pid)))
      ).every(running => !running)
    ) {
      return
    }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`ACP process tree still running: ${pids.join(', ')}`)
}

async function isRunningNonZombie(pid: number): Promise<boolean> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const closingParen = stat.lastIndexOf(')')
    return stat.slice(closingParen + 2, closingParen + 3) !== 'Z'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

describe('permission decision helpers', () => {
  const request: XaiAcpPermissionRequest = {
    sessionId: 's',
    options: [
      { optionId: 'a1', kind: 'allow_once' },
      { optionId: 'aa', kind: 'allow_always' },
      { optionId: 'r1', kind: 'reject_once' },
    ],
    raw: {},
  }

  test('reject prefers reject_once, falls back to cancelled', () => {
    expect(rejectPermissionDecision(request)).toEqual({
      outcome: 'selected',
      optionId: 'r1',
    })
    expect(
      rejectPermissionDecision({ sessionId: 's', options: [], raw: {} }),
    ).toEqual({ outcome: 'cancelled' })
  })

  test('allow prefers allow_once', () => {
    expect(allowPermissionDecision(request)).toEqual({
      outcome: 'selected',
      optionId: 'a1',
    })
  })
})
