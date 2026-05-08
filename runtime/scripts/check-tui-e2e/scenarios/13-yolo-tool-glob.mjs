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
  timeoutMs: 90_000,
  // Same residual block as 11: guardian arbiter approvalPolicy=untrusted
  // surfaces an overlay even after the mode-side bypass landed.
  skip: "guardian arbiter approvalPolicy='untrusted' still prompts; see GAP-PE-GUARDIAN-YOLO-LEAK",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Glob tool to list TypeScript files under /home/tetsuo/git/AgenC/agenc-core/runtime/src/bin/ matching the pattern 'agenc*.ts'.",
  );
  await session.submit();
  await session.waitFor(/agenc\.ts/, {
    timeout: 60_000,
    label: "glob match",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
