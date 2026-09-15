import { createHash } from "node:crypto";
import { ExecutionHostClient } from "./host-client.js";
import { validateExecutionIdentity, validExecutionOwner } from "./identity.js";
import { prepareAdmittedExecutionOperation } from "./call-context.js";
export { validateExecutionIdentity } from "./identity.js";
import {
  ExecutionEnvironmentError,
  type ExecutionEnvironmentBinding,
  type ExecutionOperationIdentity,
  type ExecutionOutputChunk,
  type ExecutionProcess,
  type ExecutionProcessReceipt,
  type ExecutionProcessSpecification,
} from "./types.js";

type DockerBinding = Extract<ExecutionEnvironmentBinding, { kind: "docker" }>;
export type DockerTaskFileBindings = Readonly<Partial<Record<"cwd" | "stdin", {
  readonly workerId: string; readonly handle: number;
}>>>;
type HostSpecification = {
  args: string[]; cwd: string; env: string[]; terminal: boolean; user: { uid: 0; gid: 0 };
  argv0?: string;
  detachedLogPath?: string;
  files?: { role: "cwd" | "stdin"; source: { workerId: string; handle: number }; identity: Record<string, unknown> }[];
};
type HostOperation = {
  id: string; session_id: number; generation: string; owner: string; authority_revision: number;
  run_id: string; call_id: string; attempt: number; operation_index: number;
  spec: HostSpecification; detached: number;
  leader_exited: number; output_complete: number; cleanup_proven: number;
  residual_processes_terminated: number;
  exit_code: number | null; failure: string | null;
  detachedService?: ExecutionProcessReceipt["detachedService"];
};

function invalid(message: string): never {
  throw new ExecutionEnvironmentError("invalid_request", message, false);
}

function specificationForHost(specification: ExecutionProcessSpecification): HostSpecification {
  if (!specification || typeof specification.program !== "string" || !specification.program ||
      !Array.isArray(specification.argv) ||
      [specification.program, ...specification.argv].some((value) => typeof value !== "string" || value.includes("\0")) ||
      typeof specification.cwd !== "string" || !specification.cwd.startsWith("/") || specification.cwd.includes("\0") ||
      typeof specification.terminal !== "boolean" ||
      !["operation", "environment"].includes(specification.lifetime) ||
      specification.environment === null || typeof specification.environment !== "object" || Array.isArray(specification.environment)) {
    invalid("Execution requires an explicit program, argv, task cwd, environment and lifetime");
  }
  if (specification.argv0 !== undefined && (typeof specification.argv0 !== "string" || specification.argv0.includes("\0"))) invalid("Invalid argv[0]");
  const env = Object.entries(specification.environment).map(([name, value]) => {
    if (!name || name.includes("=") || name.includes("\0") || name === "__AGENC_EXECUTION_LEASE_V1" ||
        typeof value !== "string" || value.includes("\0")) invalid("Invalid or reserved task environment variable");
    return `${name}=${value}`;
  });
  return { args: [specification.program, ...specification.argv], cwd: specification.cwd,
    env, terminal: specification.terminal, user: { uid: 0, gid: 0 },
    ...(specification.argv0 !== undefined ? { argv0: specification.argv0 } : {}) };
}

function specificationFromHost(spec: HostSpecification, detached: number): ExecutionProcessSpecification {
  if (!spec || !Array.isArray(spec.args) || spec.args.length === 0 || !Array.isArray(spec.env)) {
    throw new ExecutionEnvironmentError("host_protocol", "Execution host omitted the original process specification", true);
  }
  const specification: ExecutionProcessSpecification = {
    program: spec.args[0]!, argv: spec.args.slice(1), cwd: spec.cwd,
    ...(spec.argv0 !== undefined ? { argv0: spec.argv0 } : {}),
    environment: Object.fromEntries(spec.env.map((entry) => {
      const equals = entry.indexOf("=");
      if (equals < 1) throw new ExecutionEnvironmentError("host_protocol", "Invalid retained environment", true);
      return [entry.slice(0, equals), entry.slice(equals + 1)];
    })), terminal: spec.terminal, lifetime: detached ? "environment" : "operation",
  };
  specificationForHost(specification);
  return freezeSpecification(specification);
}

function freezeSpecification(specification: ExecutionProcessSpecification): ExecutionProcessSpecification {
  return Object.freeze({ ...specification, argv: Object.freeze([...specification.argv]),
    environment: Object.freeze({ ...specification.environment }) });
}

function freezeBindings(bindings: DockerTaskFileBindings | undefined): DockerTaskFileBindings | undefined {
  if (bindings === undefined) return undefined;
  if (!bindings || typeof bindings !== "object" || Array.isArray(bindings) ||
      Object.keys(bindings).some((role) => role !== "cwd" && role !== "stdin")) invalid("Invalid task file bindings");
  const result: Partial<Record<"cwd" | "stdin", { readonly workerId: string; readonly handle: number }>> = {};
  for (const role of ["cwd", "stdin"] as const) {
    const source = bindings[role];
    if (source === undefined) continue;
    if (!source || typeof source.workerId !== "string" || !/^[a-f0-9]{32}$/.test(source.workerId) ||
        !Number.isSafeInteger(source.handle) || source.handle < 1 || source.handle > 0xffffffff) invalid("Invalid held task file capability");
    result[role] = Object.freeze({ workerId: source.workerId, handle: source.handle });
  }
  return Object.freeze(result);
}

function hasBoundStdin(specification: HostSpecification): boolean {
  if (specification.files === undefined) return false;
  if (!Array.isArray(specification.files) || specification.files.length < 1 || specification.files.length > 2 ||
      specification.files.some((file) => !file || !["cwd", "stdin"].includes(file.role))) {
    throw new ExecutionEnvironmentError("host_protocol", "Invalid original descriptor layout", true);
  }
  return specification.files.some((file) => file.role === "stdin");
}

/** An operator-bound owner. This class never invokes Docker or a host process. */
export class DockerExecutionProcesses {
  readonly binding: DockerBinding;
  private readonly features: ReadonlySet<string>;
  private closed = false;

  private constructor(
    readonly client: ExecutionHostClient,
    binding: DockerBinding,
    readonly ownerId: string,
    readonly authorityRevision: number,
    readonly processHandleNamespace: string,
    features: readonly string[],
  ) { this.binding = Object.freeze({ ...binding }); this.features = new Set(features); }

  static async connect(options: {
    readonly client: ExecutionHostClient;
    readonly target: { readonly container: string } | DockerBinding;
    readonly ownerId: string;
    readonly authorityRevision: number;
  }): Promise<DockerExecutionProcesses> {
    if (!validExecutionOwner(options.ownerId) ||
        !Number.isSafeInteger(options.authorityRevision) || options.authorityRevision < 0) invalid("Invalid session execution authority");
    const capabilities = await options.client.request({ method: "capabilities" });
    const required = ["exact_environment", "argv0", "output_cursors", "terminal_resize", "authority_close", "operation_indexes", "held_task_files", "durable_process_handles"];
    const features = capabilities.features;
    if (capabilities.protocolVersion !== 1 || capabilities.runtime !== "agenc-runc" ||
        !Array.isArray(features) || required.some((feature) => !features.includes(feature))) {
      throw new ExecutionEnvironmentError("unsupported_host", "Execution host lacks required process capabilities", false);
    }
    const namespace = capabilities.processHandleNamespace;
    if (typeof namespace !== "string" || !/^[a-f0-9]{32}$/.test(namespace)) {
      throw new ExecutionEnvironmentError("host_protocol", "Execution host omitted its durable handle namespace", false);
    }
    const persisted = "kind" in options.target ? options.target : undefined;
    if (persisted !== undefined && persisted.processHandleNamespace !== namespace) {
      throw new ExecutionEnvironmentError("receipt_store_changed", "Original process handle namespace is unavailable", false);
    }
    const client = options.client.forProcessHandleNamespace(namespace);
    const result = await client.request<{ binding: DockerBinding }>({ method: "bind",
      container: persisted ? persisted.containerId : (options.target as { container: string }).container });
    if (!result.binding || !/^[a-f0-9]{64}$/.test(result.binding.containerId) || !/^[a-f0-9]{64}$/.test(result.binding.generation)) {
      throw new ExecutionEnvironmentError("host_protocol", "Execution host returned an invalid immutable binding", true);
    }
    const binding: DockerBinding = { kind: "docker", containerId: result.binding.containerId, generation: result.binding.generation,
      processHandleNamespace: namespace };
    if (persisted && (binding.containerId !== persisted.containerId || binding.generation !== persisted.generation)) {
      throw new ExecutionEnvironmentError("environment_dead", "Original task environment generation is unavailable", false);
    }
    await client.request({ method: "authorize", owner: options.ownerId,
      generation: binding.generation, authorityRevision: options.authorityRevision });
    return new DockerExecutionProcesses(client, binding, options.ownerId, options.authorityRevision, namespace, features as string[]);
  }

  assertOpen(): void {
    if (this.closed) throw new ExecutionEnvironmentError("invalid_authority", "Execution owner is closed", false);
  }

  async launch(specification: ExecutionProcessSpecification, identity: ExecutionOperationIdentity,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void },
    bindings?: DockerTaskFileBindings): Promise<ExecutionProcess> {
    this.assertOpen();
    if (specification.lifetime === "environment" && (!this.features.has("detached_task_logs") || specification.terminal || bindings?.stdin !== undefined)) {
      throw new ExecutionEnvironmentError("unsupported_operation", "Detached execution requires qualified task logs and closed non-terminal stdin", false);
    }
    validateExecutionIdentity(identity);
    const spec = specificationForHost(specification);
    const snapshot = freezeSpecification(specification);
    const files = freezeBindings(bindings);
    if (files?.stdin !== undefined && specification.terminal) invalid("A terminal cannot use bound file input");
    const result = await this.client.request<{ operationId: string; sessionId: number }>({ method: "launch",
      owner: this.ownerId, generation: this.binding.generation, authorityRevision: this.authorityRevision,
      ...identity, spec, detached: specification.lifetime === "environment",
      ...(files === undefined ? {} : { bindings: files }) },
      dispatch === undefined ? {} : { signal: dispatch.signal, beforeSend: dispatch.crossEffectBoundary });
    if (typeof result.operationId !== "string" || !/^[a-f0-9]{32}$/.test(result.operationId) ||
        !Number.isSafeInteger(result.sessionId) || result.sessionId < 1) {
      throw new ExecutionEnvironmentError("unknown_outcome", "Launch acknowledgement omitted its handle; inspect the original operation identity", true);
    }
    return new DockerExecutionProcess(this, result.operationId, result.sessionId, snapshot, files?.stdin !== undefined);
  }

  launchAdmitted(specification: ExecutionProcessSpecification, bindings?: DockerTaskFileBindings): Promise<ExecutionProcess> {
    const dispatch = prepareAdmittedExecutionOperation();
    return this.launch(specification, dispatch.identity, dispatch, bindings);
  }

  async *reconnectCall(identity: ExecutionOperationIdentity): AsyncGenerator<ExecutionProcess> {
    validateExecutionIdentity(identity);
    let after = -1;
    for (;;) {
      const result = await this.client.request<{ operations: { operationId: string; operationIndex: number }[] }>({
        method: "call_operations", owner: this.ownerId, generation: this.binding.generation,
        ...identity, kind: "process", after, maximum: 128 });
      if (!Array.isArray(result.operations) || result.operations.length > 128) {
        throw new ExecutionEnvironmentError("host_protocol", "Invalid original-operation enumeration", true);
      }
      for (const entry of result.operations) {
        if (!Number.isSafeInteger(entry.operationIndex) || entry.operationIndex <= after) {
          throw new ExecutionEnvironmentError("host_protocol", "Original-operation cursor did not advance", true);
        }
        const row = await this.inspectOperation(entry.operationId);
        this.assertCoordinate(row, { ...identity, operationIndex: entry.operationIndex });
        yield new DockerExecutionProcess(this, row.id, row.session_id, specificationFromHost(row.spec, row.detached), hasBoundStdin(row.spec));
        after = entry.operationIndex;
      }
      if (result.operations.length < 128) return;
    }
  }

  async reconnect(identity: ExecutionOperationIdentity): Promise<ExecutionProcess | undefined> {
    validateExecutionIdentity(identity);
    const result = await this.client.request<{ operationId: string | null }>({ method: "lookup",
      owner: this.ownerId, generation: this.binding.generation, ...identity });
    if (result.operationId === null) return undefined;
    const row = await this.inspectOperation(result.operationId);
    this.assertCoordinate(row, identity);
    return new DockerExecutionProcess(this, row.id, row.session_id, specificationFromHost(row.spec, row.detached), hasBoundStdin(row.spec));
  }

  private assertCoordinate(row: HostOperation, identity: ExecutionOperationIdentity): void {
    if (row.run_id !== identity.runId || row.call_id !== identity.callId || row.attempt !== identity.attempt ||
        row.operation_index !== (identity.operationIndex ?? 0)) {
      throw new ExecutionEnvironmentError("host_protocol", "Original operation does not match its canonical call coordinate", true);
    }
  }

  async inspectOperation(operationId: string): Promise<HostOperation> {
    const result = await this.client.request<{ operation: HostOperation }>({ method: "inspect", owner: this.ownerId, operationId });
    const row = result.operation;
    if (!row || row.id !== operationId || row.owner !== this.ownerId || row.generation !== this.binding.generation ||
        !Number.isSafeInteger(row.session_id) || row.session_id < 1) {
      throw new ExecutionEnvironmentError("host_protocol", "Execution receipt does not match its bound owner and generation", true);
    }
    const service = row.detachedService;
    if (service !== undefined && (row.detached !== 1 || !service ||
        service.logPath !== row.spec.detachedLogPath || !/^\/tmp\/agenc-detached-[a-f0-9]{32}\.log$/.test(service.logPath) ||
        !["waiting", "prepared", "bootstrap_closed", "failed"].includes(service.startupState) ||
        (service.pid !== undefined && (!Number.isSafeInteger(service.pid) || service.pid < 1)))) {
      throw new ExecutionEnvironmentError("host_protocol", "Invalid original detached service receipt", true);
    }
    return row;
  }

  async close(): Promise<void> {
    this.closed = true;
    const result = await this.client.request({ method: "close", owner: this.ownerId,
      generation: this.binding.generation, authorityRevision: this.authorityRevision });
    if (result.cleanupProven !== true) {
      throw new ExecutionEnvironmentError("cleanup_unproven", "Execution host did not prove owner cleanup", true);
    }
  }
}

class DockerExecutionProcess implements ExecutionProcess {
  constructor(private readonly owner: DockerExecutionProcesses, readonly operationId: string,
    readonly sessionId: number,
    readonly specification: ExecutionProcessSpecification, private readonly boundStdin: boolean) {}

  async inspect(): Promise<ExecutionProcessReceipt> {
    const row = await this.owner.inspectOperation(this.operationId);
    if (row.session_id !== this.sessionId) {
      throw new ExecutionEnvironmentError("host_protocol", "Original numeric process handle changed", true);
    }
    return { operationId: this.operationId, leaderExited: row.leader_exited === 1,
      outputComplete: row.output_complete === 1, cleanupProven: row.cleanup_proven === 1,
      ...(row.cleanup_proven === 1 && row.residual_processes_terminated === 1 ? { residualProcessesTerminated: true } : {}),
      ...(row.detachedService === undefined ? {} : { detachedService: Object.freeze({ ...row.detachedService }) }),
      exitCode: row.exit_code, ...(row.failure ? { failure: row.failure } : {}) };
  }

  async output(offset: number, maximumBytes = 262144): Promise<ExecutionOutputChunk> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maximumBytes) ||
        maximumBytes < 1 || maximumBytes > 262144) invalid("Invalid bounded output cursor");
    const result = await this.owner.client.request<{ stdout: string; stderr: string; nextOffset: number }>({
      method: "decoded_output", owner: this.owner.ownerId, operationId: this.operationId, offset, maximum: maximumBytes });
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string" ||
        !Number.isSafeInteger(result.nextOffset) || result.nextOffset < offset) {
      throw new ExecutionEnvironmentError("host_protocol", "Invalid execution output receipt", true);
    }
    const stdout = Buffer.from(result.stdout, "base64");
    const stderr = Buffer.from(result.stderr, "base64");
    const bytes = stdout.length + stderr.length;
    // Non-terminal Docker evidence includes framing headers. The cursor is a
    // retained-file position, not a count of decoded task bytes. PTYs and the
    // separate detached log stream are unframed.
    const unframed = this.specification.terminal || this.specification.lifetime === "environment";
    if (stdout.toString("base64") !== result.stdout || stderr.toString("base64") !== result.stderr ||
        bytes > maximumBytes || result.nextOffset < offset + bytes ||
        ((unframed || bytes === 0) && result.nextOffset !== offset + bytes)) {
      throw new ExecutionEnvironmentError("host_protocol", "Execution output bytes do not match their bounded cursor receipt", true);
    }
    return { stdout, stderr, nextOffset: result.nextOffset };
  }

  async write(identity: ExecutionOperationIdentity, bytes: Buffer, eof = false,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }): Promise<void> {
    this.owner.assertOpen();
    if (this.boundStdin) throw new ExecutionEnvironmentError("unsupported_operation", "Execution stdin is a bound task file", false);
    validateExecutionIdentity(identity);
    if (!Buffer.isBuffer(bytes) || bytes.length > 1024 * 1024 || typeof eof !== "boolean") invalid("Invalid bounded task input");
    await this.owner.client.request({ method: "input", owner: this.owner.ownerId, operationId: this.operationId,
      authorityRevision: this.owner.authorityRevision,
      inputId: createHash("sha256").update(JSON.stringify([identity.runId, identity.callId, identity.attempt,
        ...((identity.operationIndex ?? 0) === 0 ? [] : [identity.operationIndex])])).digest("hex"),
      data: bytes.toString("base64"), eof },
      dispatch === undefined ? {} : { signal: dispatch.signal, beforeSend: dispatch.crossEffectBoundary });
  }

  async resize(columns: number, rows: number): Promise<void> {
    this.owner.assertOpen();
    if (!this.specification.terminal) throw new ExecutionEnvironmentError("unsupported_operation", "Execution has no terminal", false);
    if ([columns, rows].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 65535)) invalid("Invalid terminal dimensions");
    await this.owner.client.request({ method: "resize", owner: this.owner.ownerId, operationId: this.operationId,
      authorityRevision: this.owner.authorityRevision, columns, rows });
  }

  async terminate(): Promise<{ readonly terminated: boolean; readonly cleanupProven: boolean }> {
    const result = await this.owner.client.request({ method: "stop", owner: this.owner.ownerId, operationId: this.operationId });
    if (typeof result.terminated !== "boolean" || result.cleanupProven !== true) {
      throw new ExecutionEnvironmentError("cleanup_unproven", "Execution host did not establish strict cleanup", true);
    }
    return { terminated: result.terminated, cleanupProven: true };
  }
}
