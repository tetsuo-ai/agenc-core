/**
 * A session whose client supplied a provider key is left for that client after
 * a daemon restart, and its next turn resumes it with the client's own
 * environment.
 *
 * The daemon never writes credentials to disk, so it cannot rebuild this
 * session with the key it had before the restart. It publishes the session
 * without a runtime instead of dialing the provider with a different (or no)
 * credential. The headless `--continue` turn then resumes the same session
 * with its snapshot, key included. Before the fix the restored runtime dialed
 * the default http://localhost:8000/v1 without the key and the turn hung.
 */
import { continueRestoredSession } from "../helpers/restored-session.mjs";

export const meta = {
  description: "A restored session with a client key resumes with the client's environment.",
  args: ["--dangerously-bypass-approvals-and-sandbox"],
  timeoutMs: 180_000,
  slimCwd: true,
};

export default async function (session) {
  await continueRestoredSession(session, /: 0 with a live runtime, 1 without one/u);
}
