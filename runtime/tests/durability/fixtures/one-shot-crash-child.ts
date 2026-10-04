import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ErrorLogSidecar } from "../../../src/session/error-log.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import { setSlowStoreOpReporter } from "../../../src/utils/slow-store-op.js";

const [command, root, boundary] = process.argv.slice(2);
if (!root) throw new Error("missing fixture root");
const cwd = join(root, "workspace"), home = join(root, "home");
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true });
process.env.AGENC_HOME = home;
setSlowStoreOpReporter(diagnostic => process.stdout.write(`${JSON.stringify({ diagnostic })}\n`));
const pathRecord = join(root, "rollout-path");
const store = new RolloutStore({ cwd, agencHome: home, sessionId: "crash-run", agencVersion: "test",
  sessionTempRoot: root, autoStartScheduler: false,
  ...(command === "crash" ? { relaxedOneShot: true } : { resume: true, resumeRolloutPath: readFileSync(pathRecord, "utf8") }),
});
const meta = { sessionId: "crash-run", cwd, timestamp: "2026-10-03T00:00:00Z", agencVersion: "test", originator: "crash-test" };
if (command === "crash") {
  store.open(meta);
  writeFileSync(pathRecord, store.rolloutPath);
  const kill = () => { process.kill(process.pid, "SIGKILL"); throw new Error("SIGKILL returned"); };
  if (boundary === "opened") kill();
  if (boundary === "pending-logs") {
    const projectDir = dirname(dirname(dirname(store.rolloutPath)));
    const sidecar = new ErrorLogSidecar({ projectDir, sessionId: "crash-run", deferStartupIndex: true });
    const warning = { id: "warning", eventId: "warning", seq: 1,
      msg: { type: "warning" as const, payload: { cause: "cron_storage_unavailable", message: "startup warning" } } };
    store.append(warning, { durable: true }); sidecar.onEvent(warning);
    writeFileSync(join(root, "logs-path"), join(projectDir, "agenc-logs_1.sqlite"));
    kill();
  }
  if (!store.append({ id: "intent", eventId: "intent", seq: 1, msg: { type: "effect_intent", payload: {
    formatVersion: 2, minimumReaderRuntime: "0.14.0", runId: "crash-run", stepId: "tool-step", callId: "call",
    toolName: "physical-counter", recoveryCategory: "side-effecting", intentDigest: "digest", attempt: 1, recordedAt: meta.timestamp,
  } } }, { durable: true })) throw new Error("intent was rejected");
  if (boundary === "intent") kill();
  // External effects survive independently of the process and canonical WAL.
  const physical = join(root, "physical-effects");
  appendFileSync(physical, "one invocation\n");
  const fd = openSync(physical, "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  if (boundary === "effect") kill();
  store.append({ id: "observed", eventId: "observed", seq: 2,
    msg: { type: "agent_message", payload: { message: "effect observed" } } }, { durable: true });
  if (boundary === "receipt") kill();
  store.close();
  kill();
} else {
  let resumed = false, refusal: string | undefined;
  try { store.open(meta); resumed = true; store.close(); }
  catch (error) { refusal = String(error); }
  process.stdout.write(JSON.stringify({ resumed, refusal, projectDir: dirname(dirname(dirname(store.rolloutPath))) }) + "\n");
}
