import { type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'

import { describe, expect, test, vi } from 'vitest'

import type { ThreadRealtimeAudioChunk } from '../../../src/app-server/protocol/index.ts'
import {
  createProcessRealtimeAudioPlayer,
  pcmBufferToRealtimeAudioChunk,
  pcmPeakLevel,
  type RealtimeAudioPlayerSpawn,
} from '../../../src/tui/realtime/audio.ts'

type TestChild = ChildProcess & {
  readonly stdin: PassThrough
}

function outputAudio(
  chunk: Buffer,
  sampleRate = 24_000,
  numChannels = 1,
): ThreadRealtimeAudioChunk {
  return {
    data: chunk.toString('base64'),
    sampleRate,
    numChannels,
  }
}

function createChild(
  writeChunk: (chunk: Buffer) => boolean = () => true,
): TestChild {
  const child = new EventEmitter() as TestChild
  const stdin = new PassThrough()
  const destroy = stdin.destroy.bind(stdin)

  stdin.write = vi.fn((chunk: Buffer | Uint8Array | string) => {
    const buffer = Buffer.isBuffer(chunk)
      ? Buffer.from(chunk)
      : Buffer.from(chunk)
    return writeChunk(buffer)
  }) as never
  stdin.destroy = vi.fn(() => destroy()) as never
  child.stdin = stdin
  child.kill = vi.fn(() => true) as never

  return child
}

describe('realtime audio coverage swarm row 106', () => {
  test('encodes capture PCM and ignores odd trailing peak bytes', () => {
    const pcm = Buffer.from([0x00, 0x20, 0xff])

    expect(pcmBufferToRealtimeAudioChunk(pcm)).toEqual({
      data: pcm.toString('base64'),
      sampleRate: 16_000,
      numChannels: 1,
      samplesPerChannel: 1,
    })
    expect(pcmPeakLevel(pcm)).toBe(16_384)
  })

  test('restarts playback when the output format changes and closes the active process', () => {
    const children = [createChild(), createChild()]
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => {
      const child = children.shift()
      if (child === undefined) throw new Error('missing child')
      return child
    })
    const player = createProcessRealtimeAudioPlayer(spawnProcess)

    player.enqueue(outputAudio(Buffer.from([1, 2]), 24_000, 1))
    player.enqueue(outputAudio(Buffer.from([3, 4]), 384_000, 8))

    expect(spawnProcess).toHaveBeenNthCalledWith(
      1,
      'play',
      [
        '-q',
        '-t',
        'raw',
        '-r',
        '24000',
        '-e',
        'signed',
        '-b',
        '16',
        '-c',
        '1',
        '-',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    expect(spawnProcess).toHaveBeenNthCalledWith(
      2,
      'play',
      [
        '-q',
        '-t',
        'raw',
        '-r',
        '384000',
        '-e',
        'signed',
        '-b',
        '16',
        '-c',
        '8',
        '-',
      ],
      { stdio: ['pipe', 'ignore', 'ignore'] },
    )
    expect(children).toHaveLength(0)

    const first = spawnProcess.mock.results[0]?.value as TestChild
    const second = spawnProcess.mock.results[1]?.value as TestChild
    expect(first.stdin.write).toHaveBeenCalledWith(Buffer.from([1, 2]))
    expect(first.stdin.destroy).toHaveBeenCalledTimes(1)
    expect(first.kill).toHaveBeenCalledWith('SIGTERM')
    expect(second.stdin.write).toHaveBeenCalledWith(Buffer.from([3, 4]))

    player.close()

    expect(second.stdin.destroy).toHaveBeenCalledTimes(1)
    expect(second.kill).toHaveBeenCalledWith('SIGTERM')
  })

  test('resets after synchronous stdin write failures and respawns on the next chunk', () => {
    const first = createChild(() => {
      throw new Error('broken pipe')
    })
    const second = createChild()
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second)
    const player = createProcessRealtimeAudioPlayer(spawnProcess)
    const chunk = outputAudio(Buffer.from([5, 6]))

    expect(() => player.enqueue(chunk)).not.toThrow()
    player.enqueue(chunk)

    expect(spawnProcess).toHaveBeenCalledTimes(2)
    expect(first.stdin.write).toHaveBeenCalledTimes(1)
    expect(second.stdin.write).toHaveBeenCalledWith(Buffer.from([5, 6]))
  })

  test('drops output whose decoded payload exceeds the process queue limit', () => {
    const spawnProcess = vi.fn<RealtimeAudioPlayerSpawn>(() => createChild())
    const player = createProcessRealtimeAudioPlayer(spawnProcess)
    const encodedLimit = Math.ceil((512 * 1024) / 3) * 4

    player.enqueue({
      data: 'A'.repeat(encodedLimit),
      sampleRate: 24_000,
      numChannels: 1,
    })

    expect(spawnProcess).not.toHaveBeenCalled()
  })
})
