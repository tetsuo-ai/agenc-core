import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'bun:test'
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from '../../src/bootstrap/state.ts'
import { CronCreateTool } from '../../src/tools/ScheduleCronTool/CronCreateTool.ts'
import { CronDeleteTool } from '../../src/tools/ScheduleCronTool/CronDeleteTool.ts'
import { CronListTool } from '../../src/tools/ScheduleCronTool/CronListTool.ts'
import { resetCronSchedulerForTests } from '../../src/utils/cronScheduler.ts'

let tempRoot: string | undefined

async function setTempProjectRoot(): Promise<void> {
  tempRoot = await mkdtemp(join(tmpdir(), 'agenc-cron-tool-'))
  setProjectRoot(tempRoot)
  setOriginalCwd(tempRoot)
  setCwdState(tempRoot)
}

afterEach(async () => {
  await resetCronSchedulerForTests()
  resetStateForTests()
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true })
    tempRoot = undefined
  }
})

test('ScheduleCron tools create, list, and delete a session cron job', async () => {
  await setTempProjectRoot()

  const input = {
    cron: '* * * * *',
    prompt: 'cron smoke prompt',
    recurring: false,
    durable: false,
  }

  expect(await CronCreateTool.validateInput(input)).toEqual({ result: true })

  const created = await CronCreateTool.call(input)
  expect(created.data.id).toMatch(/^[a-f0-9]{8}$/)
  expect(created.data.recurring).toBe(false)
  expect(created.data.durable).toBe(false)

  const listed = await CronListTool.call({})
  expect(listed.data.jobs).toEqual([
    expect.objectContaining({
      id: created.data.id,
      cron: input.cron,
      prompt: input.prompt,
      durable: false,
    }),
  ])

  expect(await CronDeleteTool.validateInput({ id: created.data.id })).toEqual({
    result: true,
  })
  await expect(CronDeleteTool.call({ id: created.data.id })).resolves.toEqual({
    data: { id: created.data.id },
  })

  const afterDelete = await CronListTool.call({})
  expect(afterDelete.data.jobs).toEqual([])
})
