import { writeFile } from "node:fs/promises";
import path from "node:path";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFrameText(session, pattern, label, timeout = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (pattern.test(session.latestFrame)) return;
    if (session.exited) {
      throw new Error(`waitForFrameText(${label}): TUI exited`);
    }
    await sleep(100);
  }
  throw new Error(
    `waitForFrameText(${label}): timeout after ${timeout}ms\n\n${session.latestFrame}`,
  );
}

export const meta = {
  description: "@ files/resources picker accepts carriage-return Enter.",
  slimCwd: true,
  timeoutMs: 45_000,
  useTempHome: true,
};

export default async function (session) {
  await writeFile(path.join(session.cwd, "PLAN.md"), "test plan\n", "utf8");

  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await session.type("@PL", { perCharMs: 60 });
  await session.waitFor(/FILES & RESOURCES/u, {
    timeout: 15_000,
    label: "files/resources picker",
  });
  await waitForFrameText(
    session,
    /❯ \+ PLAN\.md/u,
    "filtered PLAN.md picker selection",
  );
  await waitForFrameText(
    session,
    /❯\s*@PL/u,
    "composer contains filtered file query",
  );
  await sleep(120);

  session.send("\r");
  await waitForFrameText(
    session,
    /@PLAN\.md/u,
    "selected file mention inserted via carriage return",
  );

  if (/FILES & RESOURCES/u.test(session.latestFrame)) {
    throw new Error("files/resources picker remained open after carriage-return Enter");
  }

  session.send("\x15");
  await sleep(120);
}
