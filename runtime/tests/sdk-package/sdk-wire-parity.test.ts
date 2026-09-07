import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSdkWireParity } from "../../scripts/check-sdk-wire-parity.mjs";
import { renderSdkWireTypes } from "../../scripts/sdk-wire-types.mjs";

const root = resolve(import.meta.dirname, "../../..");
const protocolPath = resolve(root, "runtime/src/app-server/protocol/index.ts");
const generatedPath = resolve(
  root,
  "packages/agenc-sdk/src/protocol-wire.generated.ts",
);

describe("SDK wire parity compiler", () => {
  it("rejects optional, required and nested producer drift until regeneration", async () => {
    const original = await readFile(protocolPath, "utf8");
    const mutated = original
      .replace(
        "export interface RunEvidenceParams extends JsonObject {",
        "export interface RunEvidenceParams extends JsonObject {\n readonly wireOptionalProbe?: string;",
      )
      .replace(
        "export interface AgentLogsResult extends JsonObject {",
        "export interface AgentLogsResult extends JsonObject {\n readonly wireRequiredProbe: string;",
      )
      .replace(
        "export interface AgentRuntimeOptionsParams extends JsonObject {",
        "export interface AgentRuntimeOptionsParams extends JsonObject {\n readonly wireNestedProbe?: { readonly enabled: boolean };",
      );
    expect(mutated).not.toBe(original);
    const sourceOverrides = new Map([[protocolPath, mutated]]);
    const stale = checkSdkWireParity({ sourceOverrides });
    expect(stale.matches).toBe(false);
    expect(stale.mismatches.RequestExact).toEqual(
      expect.arrayContaining(["run.evidence", "agent.create"]),
    );
    expect(stale.mismatches.ResultExact).toEqual(
      expect.arrayContaining(["agent.logs", "agent.attach"]),
    );
    const regenerated = await renderSdkWireTypes(protocolPath, {
      sourceOverrides,
    });
    sourceOverrides.set(generatedPath, regenerated);
    const refreshed = checkSdkWireParity({ sourceOverrides });
    expect(refreshed.mismatches).toEqual({
      RequestExact: [],
      ResultExact: [],
      EnvelopeExact: [],
      ClientArgumentsExact: [],
    });
    expect(refreshed.diagnostics).toEqual([]);
    expect(refreshed.matches).toBe(true);
  }, 60_000);

  it("type-checks helper defaults and rejects missing or invalid wire payloads", () => {
    const result = checkSdkWireParity({
      consumerSource: `
import type { AgentCreateParams, AgentRuntimeOptionsParams } from "../packages/agenc-sdk/src/protocol.js";
declare const runtimeOptions: AgentRuntimeOptionsParams;
const spawn: AgentCreateParams = { runtimeOptions };
client.spawnAgent(spawn);
client.createSession({ pluginStorageRoot: "/plugins" });
client.listCsvJobReviews({ jobId: "job" });
client.showCsvJobReview({ jobId: "job", itemId: "item" });
client.request("agent.create", { ...spawn, cwd: "/workspace" });
client.request("session.create", { cwd: "/workspace" });
client.request("csvJob.review.list", { jobId: "job", cwd: "/workspace" });
client.request("health.ping");
client.request("health.ping", {});
// The daemon groups several method names into one request-union member.
client.request("remote.status", {});
client.request("telegram.status", {});
client.request("routine.list");
const grouped: AgencDaemonRequest<"remote.status"> = { jsonrpc: "2.0", id: 2, method: "remote.status", params: {} };
const result = client.request("run.status", { runId: "run" });
type InferenceMatches = RequireTrue<Equal<typeof result, Promise<AgencResultByMethod["run.status"]>>>;
// @ts-expect-error Required payload cannot be omitted.
client.request("run.status");
// @ts-expect-error Required payload cannot be undefined.
client.request("run.status", undefined);
// @ts-expect-error Required cwd belongs on the wire.
client.request("agent.create", spawn);
// @ts-expect-error Session helper defaults cannot weaken the wire shape.
client.request("session.create", {});
// @ts-expect-error CSV helper defaults cannot weaken the wire shape.
client.request("csvJob.review.list", { jobId: "job" });
// @ts-expect-error A known wire field cannot widen the method inference.
client.request("run.status", { runId: 42 });
// @ts-expect-error A helper still requires the named job id despite JsonObject's index signature.
client.listCsvJobReviews({});
// @ts-expect-error Helper fields retain their concrete types.
client.showCsvJobReview({ jobId: 42, itemId: "item" });
// @ts-expect-error The low-level request envelope requires params too.
const invalid: AgencDaemonRequest<"run.status"> = { jsonrpc: "2.0", id: 1, method: "run.status" };
const valid: AgencDaemonRequest<"health.ping"> = { jsonrpc: "2.0", id: 1, method: "health.ping" };
`,
    });
    expect(result.diagnostics).toEqual([]);
    expect(result.matches).toBe(true);
  }, 30_000);

  it("generates a deterministic standalone closure without internal RPC methods", async () => {
    const rendered = await renderSdkWireTypes(protocolPath);
    expect(rendered).toBe(
      (await readFile(generatedPath, "utf8")).replace(/\r\n?/g, "\n"),
    );
    expect(rendered).toBe(await renderSdkWireTypes(protocolPath));
    expect(rendered).not.toMatch(/^import /m);
    expect(rendered).not.toContain("AgenCDaemonInternalResultByMethod");
    expect(rendered).toContain("RunRuntimeSettingsSnapshot");
    expect(rendered).toContain('"minimal"');
  });

  it.each(["let", "var"])(
    "rejects mutable wire declarations: %s",
    async (keyword) => {
      const original = await readFile(protocolPath, "utf8");
      const mutated = original.replace(
        "export const JSON_RPC_VERSION",
        `export ${keyword} JSON_RPC_VERSION`,
      );
      expect(mutated).not.toBe(original);
      await expect(
        renderSdkWireTypes(protocolPath, {
          sourceOverrides: new Map([[protocolPath, mutated]]),
        }),
      ).rejects.toThrow(/must be const/);
    },
  );

  it.each(['(() => "2.0")()', '{ [(() => "key")()]: "2.0" }', "++counter"])(
    "rejects executable wire constants: %s",
    async (initializer) => {
      const original = await readFile(protocolPath, "utf8");
      const mutated = original.replace(
        /export const JSON_RPC_VERSION = [^;]+;/,
        `export const JSON_RPC_VERSION = ${initializer};`,
      );
      expect(mutated).not.toBe(original);
      await expect(
        renderSdkWireTypes(protocolPath, {
          sourceOverrides: new Map([[protocolPath, mutated]]),
        }),
      ).rejects.toThrow(/contains executable code/);
    },
  );
});
