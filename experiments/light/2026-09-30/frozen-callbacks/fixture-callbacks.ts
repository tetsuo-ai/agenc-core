/** One-call offline fixture only. No environment mutation or I/O at import.
 * Trusted parent must pin this module/import closure before loading it, provide
 * independently accepted material, and select Linux containment separately.
 * Nothing here initializes a ledger, spends, settles, sends IPC or finalizes.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { preparedSemanticDigest as digest } from "agenc-selected/session/prepared-sampling-evidence.js";
import type { IndependentMaterial, SelectedBinding } from "./companion-validator.js";
import { compatibility } from "./compatibility-selection.mjs";
import { pinnedBytes } from "./empty-resources.mjs";
import { financialPolicyId as deriveFinancialPolicyId } from "../luna-finance-mode-v2/journal.mjs";
import { parseLedgerBytes, numericLexeme } from "../luna-finance-v1/ledger-json.mjs";
import { ledgerExposure } from "../luna-finance-v1/accounting.mjs";

const SHA = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_.-]{1,240}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BODY_LIMIT = 1024 * 1024;
const HISTORY_LIMIT = 16 * 1024 * 1024;
const MODEL = "gpt-6-luna";
const BINDING_PIN = "9fbe3b6e75aac0f32c4c6e3276bc4a5f88d9c71631128c4f5d9b18567c972112";
const BRIDGE_PIN = "04dc2711adf9968c8003a0da0cdbd511530cff26b4b7746ed7671c0aa84185eb";
const ADAPTER_PIN = "fceb751fd4f7b5e7dc41847fc5cc1eada663a31a368c15460fb31ec81b2c2323";
const POLICY_BRIDGE_PIN = "ac8620d8fd34b2d1e22761c7034a5a1d4ca972df9ca6536395ca47ba1695b590";
export const PUBLISHER_FILES = Object.freeze({ contract: "contract.json", policy: "policy.json",
  metadata: "metadata.json", record: "publisher-record.json", pending: "publisher-record.json.pending" });
type Identity = Readonly<{ dev: string; ino: string }>;
type FinancialInventory = Readonly<{ rootDev: string; rootIno: string; journalDev: string; journalIno: string;
  prefixBytes: number; prefixSha256: string }>;
export interface FixtureCallbacksInput {
  readonly material: IndependentMaterial;
  readonly independentMaterialDigest: string;
  readonly protocolId: string;
  readonly financialRunId: string;
  readonly publicationChannelId: string;
  readonly runDirectory: string;
  readonly runDirectoryIdentity: Identity;
  readonly financialRoot: string;
  readonly financialInventory: FinancialInventory;
  readonly spendPolicy: Readonly<{ mode: "credit_exhaustion" } | { mode: "positive_cap"; capUsd: string }>;
  readonly financialPolicyId: string;
  readonly deployedSourcePins: Readonly<Record<string, string>>;
  readonly clientArtifactSha256: string;
  readonly configurationSha256: string;
  readonly pythonPath: string;
  readonly pythonSha256: string;
  readonly fairRoot: string;
}
const need = (condition: unknown): void => { if (!condition) throw new Error("cli_fixture_callback_refused"); };
const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const sameStat = (a: fs.BigIntStats, b: fs.BigIntStats): boolean =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;

// Same JSON contract as Python sort_keys/ensure_ascii/separators for this
// declaration's safe-integer subset. No floats or implicit undefined omission.
export function canonicalBytes(value: unknown): Buffer {
  digest(value); // Bounded descriptor-only validation before ordinary traversal.
  function encode(item: unknown): string {
    if (item === null) return "null";
    if (typeof item === "string" || typeof item === "boolean") return JSON.stringify(item);
    if (typeof item === "number") { need(Number.isSafeInteger(item) && !Object.is(item, -0)); return String(item); }
    if (Array.isArray(item)) return "[" + item.map(encode).join(",") + "]";
    need(item !== null && typeof item === "object");
    return "{" + Object.keys(item as object).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key =>
      JSON.stringify(key) + ":" + encode((item as Record<string, unknown>)[key])).join(",") + "}";
  }
  return Buffer.from(encode(value).replace(/[\u007f-\uffff]/g,
    c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")));
}
function directory(name: string, expected: Identity): void {
  need(path.isAbsolute(name) && path.normalize(name) === name && name !== "/" && fs.realpathSync(name) === name);
  const stat = fs.lstatSync(name, { bigint: true });
  need(stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o077n) === 0n &&
    String(stat.dev) === expected.dev && String(stat.ino) === expected.ino);
}
function regular(name: string, limit: number, expected?: Identity): Buffer {
  const named = fs.lstatSync(name, { bigint: true });
  need(named.isFile() && !named.isSymbolicLink() && named.nlink === 1n);
  const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    need(sameStat(named, before) && before.size >= 0n && before.size <= BigInt(limit));
    if (expected) need(String(before.dev) === expected.dev && String(before.ino) === expected.ino);
    const bytes = Buffer.alloc(Number(before.size) + 1); let total = 0;
    while (total < bytes.length) {
      const read = fs.readSync(fd, bytes, total, bytes.length - total, null);
      need(Number.isSafeInteger(read) && read >= 0 && read <= bytes.length - total);
      if (read === 0) break;
      total += read;
    }
    const after = fs.fstatSync(fd, { bigint: true }), namedAfter = fs.lstatSync(name, { bigint: true });
    need(total === Number(before.size) && sameStat(before, after) && sameStat(after, namedAfter) &&
      namedAfter.isFile() && !namedAfter.isSymbolicLink() && namedAfter.nlink === 1n);
    return bytes.subarray(0, total);
  } finally { fs.closeSync(fd); }
}
function absent(name: string): void {
  try { fs.lstatSync(name); } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw new Error("cli_fixture_callback_refused");
  }
  throw new Error("cli_fixture_callback_refused");
}
function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const part of Object.values(value)) freeze(part);
    Object.freeze(value);
  }
  return value;
}
function parseRequest(raw: Buffer): unknown {
  // Reuse the strict exact-lexeme parser. Replace only JSON whitespace OUTSIDE
  // strings, as in the accepted terminal helper; never repair literal newlines.
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  let quoted = false, escaped = false, normalized = "";
  for (const c of text) {
    if (quoted) {
      need(c !== "\n" && c !== "\r"); normalized += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else { if (c === '"') quoted = true; normalized += c === "\n" ? " " : c; }
  }
  const rows = parseLedgerBytes(Buffer.from(normalized + "\n")); need(rows.length === 1); return rows[0];
}
function sameParsed(a: unknown, b: unknown): boolean {
  const an = numericLexeme(a), bn = numericLexeme(b);
  if (an !== undefined || bn !== undefined) return an !== undefined && an === bn;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) &&
    a.length === b.length && a.every((value, i) => sameParsed(value, b[i]));
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, i) => key === bk[i] &&
    sameParsed((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
async function bodyBytes(request: Request): Promise<Buffer> {
  need(request.body !== null && !request.signal.aborted);
  const reader = request.body!.getReader(), chunks: Buffer[] = [];
  let size = 0, rejectAbort: (reason: Error) => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const abort = () => rejectAbort(new Error("cli_fixture_callback_refused"));
  const signal = request.signal;
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      need(next.value instanceof Uint8Array && chunks.length < 65536);
      size += next.value.byteLength; need(size <= BODY_LIMIT);
      chunks.push(Buffer.from(next.value));
    }
    need(size > 0 && !signal.aborted); return Buffer.concat(chunks, size);
  } catch {
    try { void reader.cancel().catch(() => {}); } catch { /* Refusal preserved, cancellation not EOF. */ }
    throw new Error("cli_fixture_callback_refused");
  } finally {
    signal.removeEventListener("abort", abort);
    try { reader.releaseLock(); } catch { /* No cancellation completion claim. */ }
  }
}
function textResponse(): Response {
  const id = "cli_fixture_response_1", text = "Done", item = { type: "message", id: "cli_fixture_message_1",
    role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
  const common = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [
    { type: "response.created", response: { id, model: MODEL, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", ...common, part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", ...common, delta: text },
    { type: "response.output_text.done", ...common, text },
    { type: "response.content_part.done", ...common, part: item.content[0] },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, model: MODEL, status: "completed", output: [item],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120, input_tokens_details: { cached_tokens: 0 } } } },
  ];
  return new Response(events.map((event, sequence_number) =>
    "data: " + JSON.stringify({ ...event, sequence_number }) + "\n\n").join(""),
  { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

export function createFixtureCallbacks(supplied: FixtureCallbacksInput) {
  digest(supplied); // Reject accessors/proxies before copying any caller data.
  const input = freeze(structuredClone(supplied));
  need(SHA.test(input.independentMaterialDigest) && digest(input.material) === input.independentMaterialDigest &&
    input.material.selectedOrWireObserved === false && input.material.equivalence === "fresh-empty-resource-only");
  for (const id of [input.protocolId, input.financialRunId, input.publicationChannelId]) need(ID.test(id));
  for (const hash of [input.clientArtifactSha256, input.configurationSha256, input.pythonSha256, input.financialPolicyId]) need(SHA.test(hash));
  need(path.isAbsolute(input.pythonPath) && path.isAbsolute(input.fairRoot) &&
    deriveFinancialPolicyId(input.spendPolicy) === input.financialPolicyId);
  directory(input.runDirectory, input.runDirectoryIdentity);
  directory(input.financialRoot, { dev: input.financialInventory.rootDev, ino: input.financialInventory.rootIno });
  const inventory = input.financialInventory;
  need(Number.isSafeInteger(inventory.prefixBytes) && inventory.prefixBytes >= 0 && inventory.prefixBytes <= HISTORY_LIMIT && SHA.test(inventory.prefixSha256));
  const ledger = path.join(input.financialRoot, "luna-api-ledger.jsonl");
  const ledgerIdentity = { dev: inventory.journalDev, ino: inventory.journalIno };
  const initialLedger = regular(ledger, HISTORY_LIMIT, ledgerIdentity);
  need(initialLedger.length === inventory.prefixBytes && sha(initialLedger) === inventory.prefixSha256);
  const history = parseLedgerBytes(initialLedger); ledgerExposure(history, { policyId: input.financialPolicyId });
  need(!history.some(row => row.run === input.financialRunId));
  // Exact selected source inventory only, not CLI/build closure attestation.
  const selected = JSON.parse(pinnedBytes(path.join(input.fairRoot, "current-base-binding-v2/source-pins.json"),
    compatibility.bindingInventorySha256).toString("utf8")) as Record<string, string>;
  const deployed = Object.fromEntries(Object.entries(selected).map(([name, hash]) => ["runtime/" + name, hash]));
  need(Object.keys(deployed).length === 60 && digest(deployed) === digest(input.deployedSourcePins));
  for (const [relative, pin] of Object.entries({ "luna-observer-v6/direct.mjs": compatibility.observerSha256,
    "stream_adapters.py": ADAPTER_PIN, "shared-luna-binding-v1/binding.py": BINDING_PIN,
    "shared-luna-binding-v1/bridge.py": BRIDGE_PIN, "luna-policy-v2/policy_bridge.py": POLICY_BRIDGE_PIN })) {
    pinnedBytes(path.join(input.fairRoot, relative), pin);
  }
  const paths = Object.freeze(Object.fromEntries(Object.entries(PUBLISHER_FILES)
    .map(([key, name]) => [key, path.join(input.runDirectory, name)]))) as Readonly<Record<keyof typeof PUBLISHER_FILES, string>>;
  for (const filename of Object.values(paths)) absent(filename);
  const fixedEnv = { LUNA_LEDGER_ROOT: input.financialRoot, LUNA_RUN_DIR: input.runDirectory,
    LUNA_RUN_ID: input.financialRunId, LUNA_TASK_CALL_CAP: "1" };
  function fixedEnvironment(): void {
    for (const [key, value] of Object.entries(fixedEnv)) need(process.env[key] === value);
  }
  fixedEnvironment(); need(process.env.LUNA_CAPTURE_METADATA === undefined && process.env.LUNA_CAPTURE_METADATA_SHA256 === undefined);
  let consumed = false, published = false, failed = false, fetched = false;
  let expectedTree: unknown, recordHash: string | null = null, metadataHash: string | null = null;
  function syncDirectory(): void {
    directory(input.runDirectory, input.runDirectoryIdentity);
    const fd = fs.openSync(input.runDirectory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd, { bigint: true });
      need(String(stat.dev) === input.runDirectoryIdentity.dev && String(stat.ino) === input.runDirectoryIdentity.ino);
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    directory(input.runDirectory, input.runDirectoryIdentity);
  }
  function write(filename: string, bytes: Buffer, limit: number): void {
    need(bytes.length > 0 && bytes.length <= limit);
    directory(input.runDirectory, input.runDirectoryIdentity);
    const fd = fs.openSync(filename, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try {
      let offset = 0;
      while (offset < bytes.length) {
        const count = fs.writeSync(fd, bytes, offset, bytes.length - offset, null);
        need(Number.isSafeInteger(count) && count > 0 && count <= bytes.length - offset); offset += count;
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    syncDirectory();
  }
  function publishInitialBinding(suppliedBinding: SelectedBinding): undefined {
    try {
      need(!consumed && !failed); consumed = true;
      fixedEnvironment(); need(process.env.LUNA_CAPTURE_METADATA === undefined && process.env.LUNA_CAPTURE_METADATA_SHA256 === undefined);
      digest(suppliedBinding); const binding = freeze(structuredClone(suppliedBinding));
      need(binding.independentMaterialDigest === input.independentMaterialDigest && UUID.test(binding.managedRequestId));
      for (const id of [binding.conversationId, binding.rootTurnId, binding.admissionRunId]) need(ID.test(id));
      const wire: Record<string, unknown> = { ...input.material.wireTemplate, prompt_cache_key: binding.conversationId };
      need(!Object.hasOwn(input.material.wireTemplate, "prompt_cache_key") && digest(binding.wire) === digest(wire));
      const declaredControls = { model: MODEL, stream: true, store: false, max_output_tokens: 8192,
        reasoning: { effort: "low", summary: "auto" }, include: ["reasoning.encrypted_content"],
        parallel_tool_calls: true, prompt_cache_key: binding.conversationId };
      const actualDeclaredControls = Object.fromEntries(Object.entries(wire).filter(([key]) => !["input", "instructions", "tools"].includes(key)));
      need(digest(actualDeclaredControls) === digest(declaredControls));
      const messages = wire.input;
      need(Array.isArray(messages) && messages.length === 2);
      const user = (messages as unknown[])[0] as { type?: unknown; role?: unknown; content?: unknown };
      const tail = (messages as unknown[])[1] as { type?: unknown; role?: unknown; content?: unknown };
      need(typeof wire.instructions === "string" && wire.instructions.length > 0 &&
        digest(user) === digest({ type: "message", role: "user", content: [{ type: "input_text", text: input.material.task }] }));
      need(tail !== null && tail.type === "message" && tail.role === "system" && Array.isArray(tail.content) && tail.content.length === 1);
      const dynamic = (tail.content as { type?: unknown; text?: unknown }[])[0]!;
      need(dynamic.type === "input_text" && typeof dynamic.text === "string" && dynamic.text.length > 0 &&
        digest(tail) === digest({ type: "message", role: "system", content: [{ type: "input_text", text: dynamic.text }] }));
      const taskHash = sha(input.material.task), sourceHash = sha(canonicalBytes(deployed));
      const identity = { protocol_id: input.protocolId, run_id: input.financialRunId, root_turn_id: binding.rootTurnId,
        client: "light", route: "openai-direct", task_prompt_sha256: taskHash,
        client_artifact_sha256: input.clientArtifactSha256, configuration_sha256: input.configurationSha256 };
      const envelope = Object.fromEntries(Object.entries(wire).filter(([key]) => key !== "input" && key !== "instructions"));
      const contract = { schema_version: 2, profile_id: compatibility.bindingProfile,
        ...Object.fromEntries(["protocol_id", "run_id", "root_turn_id", "task_prompt_sha256", "client_artifact_sha256", "configuration_sha256"]
          .map(key => [key, identity[key as keyof typeof identity]])),
        task_index: 0, source_inventory_sha256: sourceHash, instructions_sha256: sha(wire.instructions as string),
        auxiliary: [{ index: 1, slot: "dynamic_system", origin: "light.responses-dynamic-suffix", text_sha256: sha(dynamic.text as string) }],
        envelope_fields: Object.keys(envelope).sort(), envelope_sha256: sha(canonicalBytes(envelope)) };
      const contractBytes = canonicalBytes(contract), contractHash = sha(contractBytes);
      const policyBytes = canonicalBytes({ schema_version: 1, profile: "fixed-luna-v1", route: "openai-direct", client: "light", controls: declaredControls });
      const policyHash = sha(policyBytes);
      const metadata = { schema_version: 11, contract: "prospective-shared-source-finance-v6", client: "light", binding_profile_id: compatibility.bindingProfile,
        protocol_id: input.protocolId, run_id: input.financialRunId, root_turn_id: binding.rootTurnId, route: "openai-direct", task_prompt_sha256: taskHash,
        observer_source_sha256: compatibility.observerSha256, installed_adapter_sha256: ADAPTER_PIN,
        installed_adapter_path: path.join(input.fairRoot, "stream_adapters.py"), publication_channel_id: input.publicationChannelId,
        binding: { contract_path: paths.contract, expected: { ...identity, contract_sha256: contractHash }, deployed_source_pins: deployed,
          binding_source_sha256: BINDING_PIN, bridge_source_sha256: BRIDGE_PIN, python_path: input.pythonPath, python_sha256: input.pythonSha256 },
        fixed_policy: { policy_path: paths.policy, policy_sha256: policyHash, bridge_sha256: POLICY_BRIDGE_PIN },
        financial: { schema_version: 2, spend_policy: input.spendPolicy, policy_id: input.financialPolicyId, inventory } };
      const metadataBytes = canonicalBytes(metadata); metadataHash = sha(metadataBytes);
      const record = { schema_version: 1, contract: "current-cli-publisher-v1", ...identity,
        binding_profile_id: compatibility.bindingProfile, publication_channel_id: input.publicationChannelId,
        conversation_id: binding.conversationId, managed_request_id: binding.managedRequestId, admission_run_id: binding.admissionRunId,
        independent_material_digest: input.independentMaterialDigest, source_inventory_sha256: sourceHash,
        observer_source_sha256: compatibility.observerSha256, installed_adapter_sha256: ADAPTER_PIN, binding_source_sha256: BINDING_PIN,
        contract_sha256: contractHash, policy_sha256: policyHash, metadata_sha256: metadataHash };
      const recordBytes = canonicalBytes(record); recordHash = sha(recordBytes);
      const expectedBytes = canonicalBytes(wire);
      need(expectedBytes.length > 0 && expectedBytes.length <= BODY_LIMIT);
      expectedTree = parseRequest(expectedBytes);
      write(paths.contract, contractBytes, 256 * 1024);
      write(paths.policy, policyBytes, 64 * 1024);
      write(paths.metadata, metadataBytes, 256 * 1024);
      write(paths.pending, recordBytes, 16 * 1024);
      fs.linkSync(paths.pending, paths.record); syncDirectory();
      // Only this handoff can make the observer use the just-committed record.
      // Retain partial files on any error; never retry, unlink or refund.
      fixedEnvironment();
      process.env.LUNA_CAPTURE_METADATA = paths.metadata;
      process.env.LUNA_CAPTURE_METADATA_SHA256 = metadataHash;
      published = true; return undefined;
    } catch { failed = true; throw new Error("cli_fixture_callback_refused"); }
  }
  const fakeNativeFetch: typeof globalThis.fetch = async (request, init) => {
    try {
      need(!fetched && !failed); fetched = true;
      need(published && init === undefined && request instanceof Request);
      fixedEnvironment();
      need(process.env.LUNA_CAPTURE_METADATA === paths.metadata && process.env.LUNA_CAPTURE_METADATA_SHA256 === metadataHash);
      const actual = request as Request;
      need(actual.url === "https://api.openai.com/v1/responses" && actual.method === "POST" && actual.redirect === "manual");
      const raw = await bodyBytes(actual);
      need(sameParsed(parseRequest(raw), expectedTree));
      directory(input.financialRoot, { dev: inventory.rootDev, ino: inventory.rootIno });
      const bytes = regular(ledger, HISTORY_LIMIT, ledgerIdentity);
      need(bytes.length >= inventory.prefixBytes && sha(bytes.subarray(0, inventory.prefixBytes)) === inventory.prefixSha256);
      const rows = parseLedgerBytes(bytes); ledgerExposure(rows, { policyId: input.financialPolicyId });
      const current = rows.filter(row => row.run === input.financialRunId);
      need(current.length === 1 && current[0]!.event === "admit" && current[0]!.id === `${input.financialRunId}:1` &&
        numericLexeme(current[0]!.call) === "1" && current[0]!.request_sha256 === sha(raw) &&
        current[0]!.financial_policy_id === input.financialPolicyId && !actual.signal.aborted);
      // No accounting write here. The unchanged observer owns physical EOF,
      // terminal usage, durable settlement and genuine publication ACKs.
      return textResponse();
    } catch { failed = true; throw new Error("cli_fixture_callback_refused"); }
  };
  return Object.freeze({ publishInitialBinding, fakeNativeFetch,
    snapshot: () => Object.freeze({ consumed, published, failed, fetched, recordHash, metadataHash }) });
}
