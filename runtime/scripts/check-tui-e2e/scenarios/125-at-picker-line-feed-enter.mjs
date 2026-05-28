const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForFrameText(session, pattern, label, timeout = 10_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (pattern.test(session.latestFrame)) return;
    await sleep(100);
  }
  throw new Error(`waitForFrameText(${label}): timeout after ${timeout}ms`);
}

export const meta = {
  description: "@ files/resources picker accepts line-feed Enter.",
  slimCwd: true,
  timeoutMs: 45_000,
  useTempHome: true,
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });

  await session.type("@", { perCharMs: 60 });
  await session.waitFor(/FILES & RESOURCES/u, {
    timeout: 15_000,
    label: "files/resources picker",
  });

  session.send("\n");
  await waitForFrameText(
    session,
    /❯\s*@README\.md/u,
    "selected file mention inserted",
  );

  session.send("\x15");
  await sleep(120);
}
