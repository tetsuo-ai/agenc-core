/**
 * Yolo + Glob tool round-trip.
 *
 * Asks the model to glob the agenc-core runtime/src/bin directory. The
 * file `agenc.ts` is guaranteed to exist there, so we assert its name
 * appears in the captured transcript.
 */
export const meta = {
  description: "--yolo: model uses Glob, matched filename renders.",
  args: ["--yolo"],
  timeoutMs: 180_000,
  slimCwd: true,
  skip: "model perf ceiling on yolo + Glob; bypass proven by LLM pipeline gate",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Glob tool to list TypeScript files under /home/tetsuo/git/AgenC/agenc-core/runtime/src/bin/ matching the pattern 'agenc*.ts'.",
  );
  await session.submit();
  await session.waitFor(/agenc\.ts/, {
    timeout: 150_000,
    label: "glob match",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
