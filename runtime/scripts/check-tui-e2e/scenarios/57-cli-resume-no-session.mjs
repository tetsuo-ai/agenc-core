/**
 * Headless `agenc --resume <unknown-id>` scenario.
 *
 * Catches: a resume without a TTY hanging on Ink while it waits for stdin
 * input that will never arrive, and a headless resume of an unknown session
 * failing without saying which session was missing.
 *
 * Without a TTY, `--resume <id>` runs the prompt as one more turn of that
 * session through the daemon-backed one-shot path (docs/reference/cli.md,
 * todo-122). The one-shot path resolves the session before any daemon work,
 * so an unknown id exits 1 with a not-found message that names it. With no
 * prompt at all (stdin closed, nothing in argv) it exits 1 at prompt
 * resolution instead of waiting. The interactive TTY resume path is covered
 * by the resumeTUI unit tests.
 */
export const meta = {
  description:
    "agenc --resume <bogus> without a TTY exits 1: not-found with a prompt, no-prompt without one.",
  timeoutMs: 40_000,
};

const SESSION_ID = "session-that-does-not-exist-7c3f";

function describe(result) {
  return `code=${result.code} signal=${result.signal} stderr=${JSON.stringify(
    result.stderr.slice(0, 300),
  )} stdout=${JSON.stringify(result.stdout.slice(0, 300))}`;
}

export default async function (session) {
  // Piped stdin is the non-TTY route: the prompt arrives on stdin and the
  // session lookup has to fail before a turn starts.
  const piped = await session.runAgenc(["--resume", SESSION_ID], {
    input: "continue the task\n",
    timeoutMs: 18_000,
  });
  if (piped.code !== 1) {
    throw new Error(`expected exit 1 for an unknown headless --resume, got ${describe(piped)}`);
  }
  if (!piped.stderr.includes(`session not found`) || !piped.stderr.includes(SESSION_ID)) {
    throw new Error(`expected a not-found message naming the session, got ${describe(piped)}`);
  }

  // No prompt anywhere: stdin is closed, so the run must stop at prompt
  // resolution instead of hanging.
  const noPrompt = await session.runAgenc(["--resume", SESSION_ID], {
    timeoutMs: 18_000,
  });
  if (noPrompt.code !== 1) {
    throw new Error(`expected exit 1 for --resume without a prompt, got ${describe(noPrompt)}`);
  }
  if (!/no prompt provided/u.test(noPrompt.stderr)) {
    throw new Error(`expected the missing-prompt message, got ${describe(noPrompt)}`);
  }
}
