import { DockerExecutionProcesses } from "./docker-process.js";
import { DockerExecutionFilesystem } from "./docker-filesystem.js";
import type { ExecutionEnvironment, ExecutionOperationIdentity, ExecutionProcessSpecification } from "./types.js";

/** One immutable operator binding for task processes and the protected filesystem. */
export class DockerExecutionEnvironment implements ExecutionEnvironment {
  private constructor(readonly processes: DockerExecutionProcesses, readonly filesystem: DockerExecutionFilesystem) {}

  static async connect(options: Parameters<typeof DockerExecutionProcesses.connect>[0]): Promise<DockerExecutionEnvironment> {
    const processes = await DockerExecutionProcesses.connect(options);
    try { return new DockerExecutionEnvironment(processes, await DockerExecutionFilesystem.connect(processes)); }
    catch (error) {
      try { await processes.close(); }
      catch (cleanup) { throw new AggregateError([error, cleanup], "Environment binding failed and owner cleanup was not proved"); }
      throw error;
    }
  }

  get binding() { return this.processes.binding; }
  get ownerId() { return this.processes.ownerId; }
  get authorityRevision() { return this.processes.authorityRevision; }
  get processHandleNamespace() { return this.processes.processHandleNamespace; }

  launch(specification: ExecutionProcessSpecification, identity: ExecutionOperationIdentity,
    dispatch?: { readonly signal: AbortSignal; readonly crossEffectBoundary: () => void }) {
    return this.processes.launch(specification, identity, dispatch);
  }
  reconnect(identity: ExecutionOperationIdentity) { return this.processes.reconnect(identity); }
  close() { return this.processes.close(); }
}
