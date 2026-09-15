/** Shared by local and isolated readers without importing local spawn helpers. */
export class WorkspaceBoundReadFileTooLargeError extends Error {
  constructor(path: string, readonly size: number) {
    super(`Bound read exceeds its byte limit for ${path}`);
    this.name = "WorkspaceBoundReadFileTooLargeError";
  }
}
