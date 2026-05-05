/**
 * Turn environment selection helpers for AgenC sandbox execution.
 *
 * Source parity is documented in `parity/C-01f-parity.json`; this file keeps
 * the runtime-facing shape generic so local, remote, and test environment
 * managers can share the same validation path.
 */

export interface ExecutorFileSystem {
  readonly name?: string;
}

export interface EnvironmentHandle<
  TFileSystem extends ExecutorFileSystem = ExecutorFileSystem,
> {
  getFileSystem(): TFileSystem;
}

export interface EnvironmentManagerLike<
  TEnvironment extends EnvironmentHandle = EnvironmentHandle,
> {
  defaultEnvironmentId(): string | null | undefined;
  getEnvironment(environmentId: string): TEnvironment | null | undefined;
}

export interface TurnEnvironmentSelection {
  readonly environment_id: string;
  readonly cwd: string;
}

export interface TurnEnvironment<
  TEnvironment extends EnvironmentHandle = EnvironmentHandle,
> {
  readonly environment_id: string;
  readonly environment: TEnvironment;
  readonly cwd: string;
  readonly shell: string;
}

export class EnvironmentSelectionError extends Error {
  readonly code = "invalid_request" as const;

  constructor(message: string) {
    super(message);
    this.name = "EnvironmentSelectionError";
  }
}

export class ResolvedTurnEnvironments<
  TEnvironment extends EnvironmentHandle = EnvironmentHandle,
> {
  readonly turnEnvironments: readonly TurnEnvironment<TEnvironment>[];

  constructor(turnEnvironments: readonly TurnEnvironment<TEnvironment>[]) {
    this.turnEnvironments = [...turnEnvironments];
  }

  toSelections(): TurnEnvironmentSelection[] {
    return this.turnEnvironments.map(selectionForTurnEnvironment);
  }

  primaryTurnEnvironment(): TurnEnvironment<TEnvironment> | null {
    return this.turnEnvironments[0] ?? null;
  }

  primaryEnvironment(): TEnvironment | null {
    return this.primaryTurnEnvironment()?.environment ?? null;
  }

  primaryFileSystem(): ExecutorFileSystem | null {
    const environment = this.primaryEnvironment();
    return environment === null ? null : environment.getFileSystem();
  }
}

export function defaultThreadEnvironmentSelections(
  environmentManager: EnvironmentManagerLike,
  cwd: string,
): TurnEnvironmentSelection[] {
  const environmentId = environmentManager.defaultEnvironmentId();
  return environmentId === null || environmentId === undefined
    ? []
    : [{ environment_id: environmentId, cwd }];
}

export function resolveEnvironmentSelections<
  TEnvironment extends EnvironmentHandle,
>(
  environmentManager: EnvironmentManagerLike<TEnvironment>,
  selections: readonly TurnEnvironmentSelection[],
  options: { readonly defaultShell?: string } = {},
): ResolvedTurnEnvironments<TEnvironment> {
  const seenEnvironmentIds = new Set<string>();
  const turnEnvironments: TurnEnvironment<TEnvironment>[] = [];
  const shell = options.defaultShell ?? "bash";

  for (const selection of selections) {
    if (seenEnvironmentIds.has(selection.environment_id)) {
      throw new EnvironmentSelectionError(
        `duplicate turn environment id \`${selection.environment_id}\``,
      );
    }
    seenEnvironmentIds.add(selection.environment_id);
    const environment = environmentManager.getEnvironment(
      selection.environment_id,
    );
    if (environment === null || environment === undefined) {
      throw new EnvironmentSelectionError(
        `unknown turn environment id \`${selection.environment_id}\``,
      );
    }
    turnEnvironments.push({
      environment_id: selection.environment_id,
      environment,
      cwd: selection.cwd,
      shell,
    });
  }

  return new ResolvedTurnEnvironments(turnEnvironments);
}

export function selectionForTurnEnvironment(
  environment: Pick<TurnEnvironment, "environment_id" | "cwd">,
): TurnEnvironmentSelection {
  return {
    environment_id: environment.environment_id,
    cwd: environment.cwd,
  };
}
