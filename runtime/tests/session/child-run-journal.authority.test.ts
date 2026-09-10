import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { mountChildRunJournal, recordUnconstructedChildRunTerminal } from "../../src/session/child-run-journal.js";
import { EventLog, type Event } from "../../src/session/event-log.js";
import { RolloutStore } from "../../src/session/rollout-store.js";
import type { Session } from "../../src/session/session.js";
import { isCanonicalRolloutPayload } from "../../src/state/recovery-journal-schema.js";

let root: string;
let kernel: ExecutionAdmissionKernel;
let parent: Session;
let parentStore: RolloutStore;
const children: RolloutStore[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "agenc-child-journal-authority-"));
  const cwd = join(root, "parent");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  kernel = new ExecutionAdmissionKernel({ agencHome: join(root, "home"), ownerId: "child-journal-test", ownerPid: process.pid });
  const executionAdmission = kernel.bindClient({ cwd, scope: { runId: "parent", sessionId: "parent", autonomous: false } });
  parentStore = new RolloutStore({ cwd, agencHome: join(root, "home"), sessionId: "parent", agencVersion: "0.17.0", sessionTempRoot: join(root, "session-tmp") });
  parentStore.open({ cwd, sessionId: "parent", timestamp: new Date().toISOString(), originator: "agenc", agencVersion: "0.17.0" });
  parent = { rolloutStore: parentStore, services: { executionAdmission } } as unknown as Session;
});

afterEach(() => {
  for (const store of children.splice(0)) store.close();
  parentStore.close();
  kernel.close();
  rmSync(root, { recursive: true, force: true });
});

describe("child journal admission-owner metadata", () => {
  it("binds a constructed child to its parent's admitted workspace before events", () => {
    const cwd = join(root, "child");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const admission = parent.services.executionAdmission!.forSession({ runId: "child", sessionId: "child" });
    const eventLog = new EventLog();
    let mounted: RolloutStore | null = null;
    const child = {
      conversationId: "child", eventLog,
      sessionConfiguration: { cwd, collaborationMode: { model: "test-model" } },
      services: { executionAdmission: admission, provider: { name: "test-provider" } },
      mountRolloutStore: (store: RolloutStore | null) => { mounted = store; },
      get rolloutStore() { return mounted; },
      emit: (input: Event) => { const event = eventLog.emit(input); mounted?.append(event, { durable: true }); return event; },
      onBeforeDurableClose: () => {},
    } as unknown as Session;
    const store = mountChildRunJournal({ parent, child, originator: "agenc-subagent", terminalResult: () => ({ status: "completed", stopReason: "completed" }) })!;
    children.push(store);
    const metadata = store.readAll().find((item) => item.type === "session_meta");
    expect(metadata).toMatchObject({ payload: { sessionId: "child", cwd, admissionOwner: { workspaceId: parent.services.executionAdmission!.scope.workspaceId, runId: "child", parentRunId: "parent" } } });
    expect(store.store.agencHome).toBe(parentStore.store.agencHome);
    store.store.rewriteRolloutItemsAtomically(store.readAll());
    expect(store.readAll().find((item) => item.type === "session_meta")).toEqual(metadata);
    const wrongChild = { ...child, conversationId: "wrong-child" } as Session;
    expect(() => mountChildRunJournal({ parent, child: wrongChild, originator: "agenc-subagent", terminalResult: () => ({ status: "failed", stopReason: "failed" }) })).toThrow(/child_run_journal_identity_conflict/);
  });

  it("records the same authority when construction fails before a child exists", () => {
    const cwd = join(root, "unconstructed");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    const path = recordUnconstructedChildRunTerminal({ parent, childRunId: "unconstructed", cwd, model: "test-model", modelProvider: "test-provider", originator: "agenc-subagent", result: { status: "failed", stopReason: "construction_failed" } })!;
    const metadata = JSON.parse(readFileSync(path, "utf8").split("\n")[0]!).payload;
    expect(metadata.admissionOwner).toEqual({ workspaceId: parent.services.executionAdmission!.scope.workspaceId, runId: "unconstructed", parentRunId: "parent" });
    expect(isCanonicalRolloutPayload("session_meta", metadata)).toBe(true);
    expect(isCanonicalRolloutPayload("session_meta", { ...metadata, admissionOwner: { ...metadata.admissionOwner, runId: "" } })).toBe(false);
    const { admissionOwner: omittedOwner, ...legacyMetadata } = metadata;
    expect(isCanonicalRolloutPayload("session_meta", legacyMetadata)).toBe(true);
  });
});
