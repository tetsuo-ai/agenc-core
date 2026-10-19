import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAdmittedToolCall } from "../../../src/budget/admitted-tool-call.js";
import { ExecutionAdmissionKernel } from "../../../src/budget/execution-admission-kernel.js";
import { RolloutStore } from "../../../src/session/rollout-store.js";
import type { Event } from "../../../src/session/event-log.js";
import type { Session } from "../../../src/session/session.js";
import { createFileReadTool } from "../../../src/tools/system/file-read.js";
import type { Tool } from "../../../src/tools/types.js";

// argv: crash|recover <root> read|write|mixed <boundary>
// read:  one fast-path FileRead (call-1).
// write: one durable side-effecting call (call-1) that appends to `effects`.
// mixed: the durable write (call-0) settles first, then the fast-path read
//        (call-1) is in flight when the process dies.
const [command, root, mode, boundary] = process.argv.slice(2) as string[];
const cwd = join(root!, "workspace"), home = join(root!, "home");
mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true });
const pathRecord = join(root!, "rollout-path");
const kernel = new ExecutionAdmissionKernel({ agencHome: home });
const client = kernel.bindClient({ cwd, scope: { runId: "observation-crash", sessionId: "observation-crash", autonomous: false } });
const store = new RolloutStore({ cwd, agencHome: home, sessionId: "observation-crash", agencVersion: "test",
  sessionTempRoot: root!, autoStartScheduler: false,
  ...(command === "recover" ? { resume: true, resumeRolloutPath: readFileSync(pathRecord, "utf8") } : {}),
});
store.open({ cwd, sessionId: "observation-crash", agencVersion: "test", originator: "test", timestamp: new Date().toISOString() });
if (command !== "recover") { writeFileSync(pathRecord, store.rolloutPath); writeFileSync(join(cwd, "input.txt"), "source bytes\n"); }
let sequence = Math.max(0, ...store.readAll().filter(row => row.type === "event_msg").map(row => row.type === "event_msg" ? row.payload.seq ?? 0 : 0));
const session = { conversationId: "observation-crash", rolloutStore: store,
  services: { executionAdmission: client, admissionRequired: true },
  emit(event: Event, options?: { durable?: boolean }) {
    const stamped = { ...event, seq: ++sequence, eventId: `event:${sequence}` };
    store.append(stamped, { durable: options?.durable === true });
    return stamped;
  },
} as unknown as Session;
const kill = () => process.kill(process.pid, "SIGKILL");
const reader = createFileReadTool({ allowedPaths: [cwd], maxTokens: 1000 });
const writer = (crashes: boolean): Tool => ({
  name: "physical-counter", description: "test mutation", inputSchema: { type: "object" },
  recoveryCategory: "side-effecting", admissionEstimate: () => ({ maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }),
  async execute() {
    appendFileSync(join(root!, "effects"), "one\n");
    if (crashes && command === "crash" && boundary === "after-execution") kill();
    return { content: "wrote once" };
  },
});
const events = () => store.readAll().flatMap(row => row.type === "event_msg" ? [row.payload] : []);
const completed = (callId: string) => events().some(event => event.msg.type === "tool_call_completed" && event.msg.payload.callId === callId);

async function call(callId: string, tool: Tool, crashes: boolean): Promise<boolean> {
  if (completed(callId)) return false;
  try {
    const result = await runAdmittedToolCall({ session, turnId: "turn-1", callId, tool, args: { file_path: join(cwd, "input.txt") },
      invoke: async ({ crossEffectBoundary }) => {
        crossEffectBoundary();
        const result = await tool.execute({ file_path: join(cwd, "input.txt") });
        if (crashes && command === "crash" && tool === reader && boundary === "after-execution") kill();
        return result;
      },
    });
    session.emit({ id: `completed-${callId}`, msg: { type: "tool_call_completed", payload: {
      callId, toolName: tool.name, result: result.content, isError: false,
    } } }, { durable: true });
    return false;
  } catch (error) {
    if (command !== "recover") throw error;
    return true;
  }
}

let refused = false;
if (mode === "mixed") {
  // The durable write settles before the read; only the read may be in flight.
  refused = await call("call-0", writer(false), false);
  refused = await call("call-1", reader, true) || refused;
} else {
  refused = await call("call-1", mode === "read" ? reader : writer(true), true);
}
if (command === "crash") kill();

const records = events();
let sideEffectAdmission = "allowed";
try { store.assertToolAdmissionAllowed("side-effecting"); } catch (error) { sideEffectAdmission = (error as Error).name; }
const report = { refused, effects: existsSync(join(root!, "effects")) ? readFileSync(join(root!, "effects"), "utf8") : "",
  effectIntents: records.filter(event => event.msg.type === "effect_intent").length,
  effectIntentCalls: records.flatMap(event => event.msg.type === "effect_intent" ? [event.msg.payload.callId] : []),
  unknownOutcomes: records.filter(event => event.msg.type === "effect_unknown_outcome").length,
  completions: records.filter(event => event.msg.type === "tool_call_completed").length,
  completedCalls: records.flatMap(event => event.msg.type === "tool_call_completed" ? [event.msg.payload.callId] : []),
  journals: kernel.listJournal({ cwd, runId: "observation-crash" }).map(row => row.event),
  journalSteps: [...new Set(kernel.listJournal({ cwd, runId: "observation-crash" }).map(row => row.stepId))],
  pendingEffectReviews: store.hasPendingEffectReviews(),
  sideEffectAdmission,
};
store.close(); kernel.close();
process.stdout.write(JSON.stringify(report) + "\n");
