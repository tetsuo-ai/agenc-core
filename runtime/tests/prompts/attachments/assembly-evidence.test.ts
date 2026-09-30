import { describe, expect, test, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createEmptyToolPermissionContext } from "../../../src/permissions/types.js";
import { getAttachmentTrackingState } from "../../../src/session/attachment-state.js";
import {
  __INTERNAL, getAttachments, type GetAttachmentsOptions,
} from "../../../src/prompts/attachments/orchestrator.js";
import {
  AttachmentEvidenceError, buildAttachmentAssemblyEvidence,
  deliverAttachmentAssemblyEvidence, MAX_ATTACHMENT_EVIDENCE_OUTPUTS,
  MAX_ATTACHMENT_EVIDENCE_PRODUCERS,
  type AttachmentAssemblyEvidence, type AttachmentEvidenceCollector,
} from "../../../src/prompts/attachments/assembly-evidence.js";
import type { Attachment } from "../../../src/prompts/attachments/types.js";

const ids = ["plan_mode", "verify_plan_reminder", "auto_mode", "swarm_mode",
  "deferred_tools_delta", "requested_tools", "agent_listing_delta", "mcp_instructions_delta",
  "date_change", "instruction_update", "critical_reminder", "output_style",
  "relevant_memories", "changed_files", "lsp_diagnostics", "agent_mentions",
  "mcp_resources", "file_mentions", "skill_listing"];
function options(partial: Partial<GetAttachmentsOptions> = {}): GetAttachmentsOptions {
  const opts: GetAttachmentsOptions = {
    sessionKey: {}, lightMode: true, userInput: null, loadedTools: [], messages: [],
    permissionContext: createEmptyToolPermissionContext(), cwd: "/tmp/attachment-evidence-fixture",
    agencHome: "/tmp/attachment-evidence-private-home", subagentDepth: 0,
    signal: new AbortController().signal, ...partial,
  };
  getAttachmentTrackingState(opts.sessionKey).memoryMode = "disabled";
  return opts;
}
const fulfilled = (value: readonly Attachment[]): PromiseFulfilledResult<readonly Attachment[]> => ({ status: "fulfilled", value });
const emptyReport = () => buildAttachmentAssemblyEvidence("local_read_only", [], []);

describe("same-invocation attachment evidence", () => {
  test("absent collector parity and all selected invocations appear once in canonical order", async () => {
    const reports: AttachmentAssemblyEvidence[] = [];
    const without = await getAttachments(options());
    const withEvidence = await getAttachments(options({ collectAssemblyEvidence: report => { reports.push(report); } }));
    expect(withEvidence).toEqual(without); expect(without).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(__INTERNAL.ordinaryProducerIds).toEqual(ids);
    expect(reports[0]).toEqual({ schemaVersion: 1, collection: "ordinary", inventory: "complete",
      unknownReason: null, outcomes: ids.map(producer => ({ producer, status: "fulfilled", outputCount: 0, outputKinds: [] })) });
  });

  test("same flattened empty output distinguishes one rejected invocation without changing legacy logging", async () => {
    const secret = new Error("SYNTHETIC_PRIVATE_REJECTION"); let calls = 0;
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const reports: AttachmentAssemblyEvidence[] = [];
    const failingSession = () => ({ services: { mcpManager: { getConnectedServers() { calls++; throw secret; } } } });
    try {
      const without = await getAttachments(options({ sessionKey: failingSession() }));
      const withEvidence = await getAttachments(options({ sessionKey: failingSession(),
        collectAssemblyEvidence: report => { reports.push(report); } }));
      expect(withEvidence).toEqual(without); expect(without).toEqual([]); expect(calls).toBe(2);
      expect(log).toHaveBeenCalledTimes(2);
      expect(reports[0]!.outcomes.find(row => row.producer === "mcp_instructions_delta"))
        .toEqual({ producer: "mcp_instructions_delta", status: "rejected", outputCount: 0, outputKinds: [] });
      expect(JSON.stringify(reports)).not.toContain(secret.message);
      expect(reports[0]!.outcomes.filter(row => row.status === "rejected")).toHaveLength(1);
    } finally { log.mockRestore(); }
  });

  test("one-shot output is not recollected; report is detached deeply frozen and payload-free", async () => {
    const reports: AttachmentAssemblyEvidence[] = [], opts = options({ collectAssemblyEvidence: report => { reports.push(report); } });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.pendingCriticalReminder = "SYNTHETIC_PRIVATE_REMINDER";
    const first = await getAttachments(opts);
    expect(first).toEqual([{ kind: "critical_system_reminder", content: "SYNTHETIC_PRIVATE_REMINDER" }]);
    expect(tracking.pendingCriticalReminder).toBeUndefined();
    expect(await getAttachments(opts)).toEqual([]); expect(reports).toHaveLength(2);
    const row = reports[0]!.outcomes.find(item => item.producer === "critical_reminder")!;
    expect(row.outputKinds).toEqual(["critical_system_reminder"]); expect(row.outputCount).toBe(1);
    expect(reports[1]!.outcomes.find(item => item.producer === "critical_reminder")!.outputCount).toBe(0);
    for (const object of [reports[0], reports[0]!.outcomes, row, row.outputKinds]) expect(Object.isFrozen(object)).toBe(true);
    expect(() => { (row.outputKinds as string[]).push("date_change"); }).toThrow();
    (first[0] as { content: string }).content = "changed source object";
    (first[0] as { kind: string }).kind = "date_change";
    expect(row.outputKinds).toEqual(["critical_system_reminder"]);
    expect(JSON.stringify(reports)).not.toContain("SYNTHETIC_PRIVATE_REMINDER");
    expect(JSON.stringify(reports)).not.toContain("changed source object");
  });

  test("collector failure never restores or repeats consumed one-shot state", async () => {
    const opts = options({ collectAssemblyEvidence: () => { throw null; } });
    const tracking = getAttachmentTrackingState(opts.sessionKey);
    tracking.pendingCriticalReminder = "one shot";
    await expect(getAttachments(opts)).rejects.toBeInstanceOf(AttachmentEvidenceError);
    expect(tracking.pendingCriticalReminder).toBeUndefined();
    await expect(getAttachments({ ...opts, collectAssemblyEvidence: undefined })).resolves.toEqual([]);
  });

  test("local read-only selects no producers and does not consume ordinary one-shot state", async () => {
    const reports: AttachmentAssemblyEvidence[] = [], opts = options({ effectsPolicy: "local_read_only",
      collectAssemblyEvidence: report => { reports.push(report); } });
    getAttachmentTrackingState(opts.sessionKey).pendingCriticalReminder = "retained";
    expect(await getAttachments(opts)).toEqual([]);
    expect(reports).toEqual([{ schemaVersion: 1, collection: "local_read_only", inventory: "complete", unknownReason: null, outcomes: [] }]);
    expect(getAttachmentTrackingState(opts.sessionKey).pendingCriticalReminder).toBe("retained");
  });

  test("original cancellation identity wins and collector is never called after already-cancelled collection", async () => {
    for (const effectsPolicy of [undefined, "local_read_only"] as const) {
      const controller = new AbortController(), reason = { cancellation: "original" };
      controller.abort(reason); const collector = vi.fn(() => { throw "must not replace cancellation"; });
      await expect(getAttachments(options({ effectsPolicy, signal: controller.signal, collectAssemblyEvidence: collector }))).rejects.toBe(reason);
      expect(collector).not.toHaveBeenCalled();
    }
  });

  test("cancellation initiated inside collector wins over throw or invalid return", () => {
    for (const fail of [false, true]) {
      const controller = new AbortController(), reason = { cancellation: "original" };
      const collector = (() => { controller.abort(reason); if (fail) throw new Error("private"); return null; }) as unknown as AttachmentEvidenceCollector;
      let caught: unknown;
      try { deliverAttachmentAssemblyEvidence(emptyReport(), collector, controller.signal); } catch (error) { caught = error; }
      expect(caught).toBe(reason);
    }
  });

  test("producer AbortError identity remains primary without an aborted signal", async () => {
    const reason = new DOMException("synthetic cancellation", "AbortError");
    const collector = vi.fn(() => undefined);
    const sessionKey = { services: { mcpManager: { getConnectedServers() { throw reason; } } } };
    await expect(getAttachments(options({ sessionKey, collectAssemblyEvidence: collector }))).rejects.toBe(reason);
    expect(collector).not.toHaveBeenCalled();
  });

  test("local-read-only absent collector retains its original aborted-signal shortcut", async () => {
    const controller = new AbortController(); controller.abort(new Error("synthetic cancellation"));
    await expect(getAttachments(options({ effectsPolicy: "local_read_only", signal: controller.signal }))).resolves.toEqual([]);
  });

  test("inventory bounds are explicit unknown, never successful truncation", () => {
    const attachment: Attachment = { kind: "critical_system_reminder", content: "private" };
    const exact = Array.from({ length: MAX_ATTACHMENT_EVIDENCE_OUTPUTS }, () => attachment);
    expect(buildAttachmentAssemblyEvidence("ordinary", ["critical_reminder"], [fulfilled(exact)]).inventory).toBe("complete");
    for (const settled of [[fulfilled([...exact, attachment])], [fulfilled(exact), fulfilled([attachment])]]) {
      const report = buildAttachmentAssemblyEvidence("ordinary", settled.length === 1 ? ["critical_reminder"] : ["critical_reminder", "date_change"], settled);
      expect(report.inventory).toBe("unknown"); expect(report.unknownReason).toBe("output_inventory_limit");
      expect(report.outcomes.every(row => row.outputKinds === null)).toBe(true);
    }
    expect(buildAttachmentAssemblyEvidence("ordinary", Array(MAX_ATTACHMENT_EVIDENCE_PRODUCERS + 1).fill("critical_reminder"), [])).toMatchObject({ inventory: "unknown", unknownReason: "output_inventory_limit", outcomes: [] });
    expect(buildAttachmentAssemblyEvidence("local_read_only", ["critical_reminder"], [fulfilled([])]).inventory).toBe("unknown");
  });

  test("unrecognized kinds and accessor fields cannot become payload metadata", () => {
    let reads = 0;
    for (const item of [{ kind: "SYNTHETIC_SECRET_KIND" }, { get kind() { reads++; return "date_change"; } },
      new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("SYNTHETIC_SECRET_KIND"); } })]) {
      const report = buildAttachmentAssemblyEvidence("ordinary", ["date_change"], [fulfilled([item as Attachment])]);
      expect(report.inventory).toBe("unknown"); expect(report.unknownReason).toBe("invalid_output_inventory");
      expect(JSON.stringify(report)).not.toContain("SYNTHETIC_SECRET_KIND");
    }
    expect(reads).toBe(0);
  });

  test("throwing values and non-undefined callback returns are static failures without thenable access", () => {
    let reads = 0;
    for (const returned of [null, false, 0, "private", {}, { get then() { reads++; throw null; } }]) {
      const collector = (() => returned) as unknown as AttachmentEvidenceCollector;
      expect(() => deliverAttachmentAssemblyEvidence(emptyReport(), collector, new AbortController().signal))
        .toThrowError("Attachment evidence collector failed");
    }
    for (const thrown of [undefined, null, "private", { get message() { reads++; throw null; } }]) {
      expect(() => deliverAttachmentAssemblyEvidence(emptyReport(), () => { throw thrown; }, new AbortController().signal))
        .toThrowError("Attachment evidence collector failed");
    }
    expect(reads).toBe(0);
    expect(() => deliverAttachmentAssemblyEvidence(emptyReport(), () => undefined, new AbortController().signal)).not.toThrow();
  });

  test("native Promise returns are refused and rejected ones observed in isolated strict subprocess", () => {
    const moduleUrl = pathToFileURL(resolve("src/prompts/attachments/assembly-evidence.ts")).href;
    const code = `import {buildAttachmentAssemblyEvidence,deliverAttachmentAssemblyEvidence} from ${JSON.stringify(moduleUrl)};
let invoked=0;
for(const factory of [()=>Promise.resolve(),()=>Promise.reject(new Error('SYNTHETIC_PRIVATE')),
()=>{const p=Promise.reject(null);p.then=()=>{invoked++;throw null;};return p;}]) {
 let refused=false;try{deliverAttachmentAssemblyEvidence(buildAttachmentAssemblyEvidence('local_read_only',[],[]),factory,new AbortController().signal);}
 catch(error){refused=error.code==='attachment_evidence_collector_failed';}
 if(!refused)process.exit(2);
}
await new Promise(resolve=>setImmediate(resolve));if(invoked)process.exit(3);console.log('contained');`;
    const result = spawnSync(process.execPath, ["--unhandled-rejections=strict", "--input-type=module", "-e", code],
      { encoding: "utf8", env: {}, timeout: 3000, maxBuffer: 4096 });
    expect(result.status).toBe(0); expect(result.stdout.trim()).toBe("contained"); expect(result.stderr).toBe("");
  });
});
