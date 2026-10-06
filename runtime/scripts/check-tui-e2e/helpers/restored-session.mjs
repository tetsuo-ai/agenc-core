/**
 * Shared steps for the scenarios that drive a session restored by a daemon
 * restart. After a restart the TUI refuses further submissions until it is
 * re-attached, so the restored session is driven with a headless
 * `agenc --continue -p` turn from the same gate environment.
 */
import { createServer } from "node:http";

const RESTORE_SUMMARY = /daemon restored (\d+) session\(s\) open at its last shutdown[^\n]*/u;

/** Run one TUI turn, restart the gate daemon, and return its restore summary line. */
async function restartAfterOneTurn(session, { timeoutMs = 30_000 } = {}) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type("hi");
  await session.submit();
  await session.waitForAssistantReply({ timeout: 60_000 });
  await session.waitForIdle({ timeout: 60_000 });
  const pid = await session.restartGateDaemon();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    session.throwIfAborted();
    const summary = RESTORE_SUMMARY.exec(session.gateDaemonStderr(pid));
    if (summary !== null) return summary[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `restarted daemon logged no restore summary within ${timeoutMs}ms:\n${session.gateDaemonStderr(pid)}`,
  );
}

/**
 * Record requests sent to the openai-compatible default endpoint
 * (http://localhost:8000/v1). A session that lost its configured base URL
 * dials it. When the port is taken the watch is unavailable, and the
 * scenario relies on its turn assertion alone.
 */
async function watchDefaultOpenAICompatibleEndpoint() {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.writeHead(503).end();
  });
  const listening = await new Promise((resolve) => {
    server.once("error", () => resolve(false));
    server.listen(8000, "127.0.0.1", () => resolve(true));
  });
  return {
    available: listening,
    requests,
    close: () =>
      listening ? new Promise((resolve) => server.close(resolve)) : Promise.resolve(),
  };
}

/** Send one headless turn to the newest session of the gate project. */
async function continueHeadless(session, prompt, { timeoutMs = 45_000 } = {}) {
  const result = await session.runAgenc(
    ["--dangerously-bypass-approvals-and-sandbox", "--continue", "-p", prompt],
    { timeoutMs },
  );
  if (result.code !== 0 || result.stdout.trim().length === 0) {
    throw new Error(
      `headless continue exited ${result.code} with stdout ${JSON.stringify(result.stdout)}; stderr: ${result.stderr.slice(0, 600)}`,
    );
  }
  return result;
}

/** Assert the prompt ran as a completed turn of the one restored session. */
async function assertTurnCompletedInRestoredSession(session, prompt) {
  const items = await session.readRolloutItems();
  const sessionIds = new Set(
    items
      .filter((item) => item?.type === "session_meta")
      .map((item) => item.payload?.sessionId),
  );
  if (sessionIds.size !== 1) {
    throw new Error(`expected one session, found ${JSON.stringify([...sessionIds])}`);
  }
  const messages = items.map((item) => item?.payload?.msg).filter(Boolean);
  const promptIndex = messages.findIndex(
    (msg) => msg.type === "user_message" && msg.payload?.message === prompt,
  );
  if (promptIndex < 0) {
    throw new Error(`the restored session has no user message ${JSON.stringify(prompt)}`);
  }
  const completed = messages
    .slice(promptIndex)
    .some((msg) => msg.type === "turn_complete" && msg.payload?.lastAgentMessage);
  if (!completed) {
    throw new Error(`the restored session did not complete the turn for ${JSON.stringify(prompt)}`);
  }
}

/**
 * Run one TUI turn, restart the daemon, check its restore summary, and send
 * one headless turn to the restored session. The turn must complete in that
 * session, and nothing may reach the openai-compatible default endpoint.
 */
export async function continueRestoredSession(session, expectedSummary, prompt = "and again") {
  const defaultEndpoint = await watchDefaultOpenAICompatibleEndpoint();
  let failure = null;
  try {
    const summary = await restartAfterOneTurn(session);
    if (!expectedSummary.test(summary)) {
      throw new Error(`unexpected restore outcome: ${summary}`);
    }
    await continueHeadless(session, prompt);
  } catch (error) {
    failure = error;
  } finally {
    await defaultEndpoint.close();
  }
  if (defaultEndpoint.requests.length > 0) {
    throw new Error(
      `the restored session dialed the openai-compatible default endpoint: ${defaultEndpoint.requests.join(", ")}` +
        (failure === null ? "" : `\n${failure.message}`),
    );
  }
  if (failure !== null) throw failure;
  await assertTurnCompletedInRestoredSession(session, prompt);
}
