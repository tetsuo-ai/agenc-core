/**
 * A session restored by a daemon restart reaches the provider endpoint its
 * client configured.
 *
 * Guards a fixed failure: the daemon rebuilt the sessions open at its last
 * shutdown from the client's PATH alone. A restored openai-compatible session
 * lost OPENAI_COMPATIBLE_BASE_URL, dialed the default http://localhost:8000/v1,
 * and its next turn waited in provider-outage retries for 30 minutes.
 *
 * This client sets no API key, so the daemon rebuilds the session with a live
 * runtime from the endpoint recorded at creation. Scenario 142 covers a client
 * that supplied a key.
 */
import { continueRestoredSession } from "../helpers/restored-session.mjs";

export const meta = {
  description: "A session restored with a live runtime keeps its provider endpoint.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  env: { OPENAI_COMPATIBLE_API_KEY: "" },
  timeoutMs: 180_000,
  slimCwd: true,
};

export default async function (session) {
  await continueRestoredSession(session, /: 1 with a live runtime, 0 without one/u);
}
