import "../helpers/cron-os-home.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import {
  resetStateForTests,
  setCwdState,
  setOriginalCwd,
  setProjectRoot,
} from "../../src/bootstrap/state.ts";
import { CronCreateTool } from "../../src/tools/ScheduleCronTool/CronCreateTool.ts";
import { CronDeleteTool } from "../../src/tools/ScheduleCronTool/CronDeleteTool.ts";
import { CronListTool } from "../../src/tools/ScheduleCronTool/CronListTool.ts";
import { readEffectBoundaryNotCrossed } from "../../src/tools/effect-boundary.ts";
import { resetCronSchedulerForTests } from "../../src/utils/cronScheduler.ts";

let tempRoot: string | undefined;
const toolContext = {
  sessionId: "cron-tool-test-session",
} as never;

async function setTempProjectRoot(): Promise<void> {
  tempRoot = await mkdtemp(join(tmpdir(), "agenc-cron-tool-"));
  setProjectRoot(tempRoot);
  setOriginalCwd(tempRoot);
  setCwdState(tempRoot);
}

afterEach(async () => {
  await resetCronSchedulerForTests();
  resetStateForTests();
  if (tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
    tempRoot = undefined;
  }
});

test("ScheduleCron tools create, list, and delete a session cron job", async () => {
  await setTempProjectRoot();

  const input = {
    cron: "* * * * *",
    prompt: "cron smoke prompt",
    recurring: false,
    durable: false,
  };

  expect(await CronCreateTool.validateInput(input, toolContext)).toEqual({
    result: true,
  });

  const created = await CronCreateTool.call(input, toolContext);
  expect(created.data.id).toMatch(/^[a-f0-9]{8}$/);
  expect(created.data.recurring).toBe(false);
  expect(created.data.durable).toBe(false);

  const listed = await CronListTool.call({}, toolContext);
  expect(listed.data.jobs).toEqual([
    expect.objectContaining({
      id: created.data.id,
      cron: input.cron,
      prompt: input.prompt,
      durable: false,
    }),
  ]);
  expect(listed.data.warning).toBeUndefined();

  expect(
    await CronDeleteTool.validateInput({ id: created.data.id }, toolContext),
  ).toEqual({
    result: true,
  });
  await expect(
    CronDeleteTool.call({ id: created.data.id }, toolContext),
  ).resolves.toEqual({
    data: { id: created.data.id },
  });

  const afterDelete = await CronListTool.call({}, toolContext);
  expect(afterDelete.data.jobs).toEqual([]);
});

test("ScheduleCron defaults to session-only jobs while delivery forces durability", async () => {
  await setTempProjectRoot();
  const local = await CronCreateTool.call({
    cron: "*/5 * * * *", prompt: "local default",
  }, toolContext);
  expect(local.data.durable).toBe(false);
  const createDelivery = () => CronCreateTool.call({
    cron: "*/5 * * * *", prompt: "delivery default", durable: false,
    announceChannel: "stdio", announceTo: "test-recipient",
  }, toolContext);
  if (process.platform === "darwin") {
    const validationError = await CronCreateTool.validateInput({
      cron: "*/5 * * * *", prompt: "delivery default", durable: false,
      announceChannel: "stdio", announceTo: "test-recipient",
    }, toolContext).catch((cause: unknown) => cause);
    expect(validationError).toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(readEffectBoundaryNotCrossed(validationError, new Date().toISOString())).toBeDefined();
    const error = await createDelivery().catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
    expect(readEffectBoundaryNotCrossed(error, new Date().toISOString())).toBeUndefined();
  } else {
    const delivery = await createDelivery();
    expect(delivery.data.durable).toBe(true);
  }
});

test("a legacy durable CronDelete post-admission refusal does not infer no effect", async () => {
  if (process.platform !== "darwin") return;
  await setTempProjectRoot();
  const metadata = join(tempRoot!, ".agenc");
  await mkdir(metadata, { mode: 0o700 });
  await writeFile(join(metadata, "scheduled_tasks.json"), JSON.stringify({
    tasks: [{ id: "durable-job", cron: "* * * * *", prompt: "work", createdAt: 1_000 }],
  }), { mode: 0o600 });
  const listed = await CronListTool.call({}, toolContext);
  expect(listed.data.jobs).toEqual([]);
  expect(listed.data.warning).toContain("only session jobs");
  const validationError = await CronDeleteTool.validateInput({ id: "durable-job" }, toolContext)
    .catch((cause: unknown) => cause);
  expect(validationError).toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
  expect(readEffectBoundaryNotCrossed(validationError, new Date().toISOString())).toBeDefined();
  const error = await CronDeleteTool.call({ id: "durable-job" }, toolContext)
    .catch((cause: unknown) => cause);
  expect(error).toMatchObject({ code: "DESCRIPTOR_UNSUPPORTED" });
  expect(readEffectBoundaryNotCrossed(error, new Date().toISOString())).toBeUndefined();
});
