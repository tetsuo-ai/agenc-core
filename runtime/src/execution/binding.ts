import { ExecutionEnvironmentError, type ExecutionEnvironmentBinding } from "./types.js";

export const LOCAL_EXECUTION_ENVIRONMENT: ExecutionEnvironmentBinding = Object.freeze({ kind: "local" });

/** Journal identity only. Selectors, control sockets and credentials are never persisted here. */
export function readExecutionEnvironmentBinding(value: unknown): ExecutionEnvironmentBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidBinding();
  const binding = value as Record<string, unknown>;
  const keys = Object.keys(binding).sort();
  if (binding.kind === "local" && keys.join(",") === "kind") return LOCAL_EXECUTION_ENVIRONMENT;
  if (binding.kind === "docker" && keys.join(",") === "containerId,generation,kind,processHandleNamespace" &&
      typeof binding.containerId === "string" && /^[a-f0-9]{64}$/.test(binding.containerId) &&
      typeof binding.generation === "string" && /^[a-f0-9]{64}$/.test(binding.generation) &&
      typeof binding.processHandleNamespace === "string" && /^[a-f0-9]{32}$/.test(binding.processHandleNamespace)) {
    return Object.freeze({ kind: "docker", containerId: binding.containerId, generation: binding.generation,
      processHandleNamespace: binding.processHandleNamespace });
  }
  return invalidBinding();
}

function invalidBinding(): never {
  throw new ExecutionEnvironmentError("invalid_execution_binding", "Persisted execution environment identity is missing or invalid", false);
}

/** Pre-isolation rollouts always mean local execution, including during migration. */
export function executionEnvironmentFromSessionMeta(meta: {
  readonly rolloutSchemaVersion: number; readonly executionEnvironment?: unknown;
}): ExecutionEnvironmentBinding {
  if (meta.rolloutSchemaVersion < 6) {
    if (meta.executionEnvironment !== undefined && readExecutionEnvironmentBinding(meta.executionEnvironment).kind !== "local") {
      throw new ExecutionEnvironmentError("invalid_execution_binding", "Legacy rollout cannot authorize container execution", false);
    }
    return LOCAL_EXECUTION_ENVIRONMENT;
  }
  return readExecutionEnvironmentBinding(meta.executionEnvironment);
}

export function assertSameExecutionEnvironment(actual: ExecutionEnvironmentBinding, expected: ExecutionEnvironmentBinding): void {
  const left = readExecutionEnvironmentBinding(actual), right = readExecutionEnvironmentBinding(expected);
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new ExecutionEnvironmentError("execution_environment_changed", "Original execution environment identity is unavailable or differs from the persisted session", false);
  }
}
