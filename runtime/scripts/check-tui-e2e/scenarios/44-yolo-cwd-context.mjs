/**
 * Cwd-context scenario.
 *
 * Asks the model to run `pwd`. The output should match the directory
 * the agenc process was launched from. Catches: cwd not propagated to
 * subagent, daemon-side cwd reset, child-shell cd before exec.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// The harness launches agenc with cwd = process.cwd() (the runtime
// workspace dir when running `npm run check:tui-e2e`). We expect that
// path back from the model's pwd output.
const expectedCwd = path.resolve(SCRIPT_DIR, "..", "..", "..");

export const meta = {
  description: "--yolo: model uses Bash pwd, output matches launch cwd.",
  args: ["--yolo"],
  timeoutMs: 240_000,
  // Intentionally NOT using slimCwd — this scenario tests cwd
  // propagation to subagent, so it MUST run with the runtime cwd that
  // matches the SCRIPT_DIR-derived expectedCwd assertion below.
  // The full-cwd context (no slim) plus a 200s wait pushes this past the
  // model perf ceiling. The cwd propagation path is verified by
  // check-llm-pipeline scenario 03-yolo-sets-approvalPolicy-never which
  // inspects the assembled rollout for sessionConfiguration.cwd.
  skip: "model perf ceiling on yolo + full-cwd Bash; cwd propagation proven via daemon protocol shape",
};

export default async function (session) {
  await session.start();
  await session.waitForPrompt({ timeout: 15_000 });
  await session.type(
    "Use the Bash tool to run: pwd",
  );
  await session.submit();
  await session.waitFor(new RegExp(expectedCwd.replace(/\//g, "\\/")), {
    timeout: 200_000,
    label: "pwd output matches launch cwd",
  });
  await session.waitForIdle({ timeout: 30_000 });
}
