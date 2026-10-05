/** Async file operations load their implementation before validating or acquiring capabilities. */
type Runtime = typeof import("./file-mutation-transaction.js");

export async function bindWorkspaceDirectoryMutation(...args: Parameters<Runtime["bindWorkspaceDirectoryMutation"]>): ReturnType<Runtime["bindWorkspaceDirectoryMutation"]> {
  const runtime = await import("./file-mutation-transaction.js");
  return runtime.bindWorkspaceDirectoryMutation(...args);
}

export async function bindWorkspaceDirectoryReadCapability(...args: Parameters<Runtime["bindWorkspaceDirectoryReadCapability"]>): ReturnType<Runtime["bindWorkspaceDirectoryReadCapability"]> {
  const runtime = await import("./file-mutation-transaction.js");
  return runtime.bindWorkspaceDirectoryReadCapability(...args);
}

export async function bindWorkspaceFileReadCapability(...args: Parameters<Runtime["bindWorkspaceFileReadCapability"]>): ReturnType<Runtime["bindWorkspaceFileReadCapability"]> {
  const runtime = await import("./file-mutation-transaction.js");
  return runtime.bindWorkspaceFileReadCapability(...args);
}

export async function captureWorkspaceFilePathTransactionGuard(...args: Parameters<Runtime["captureWorkspaceFilePathTransactionGuard"]>): ReturnType<Runtime["captureWorkspaceFilePathTransactionGuard"]> {
  const runtime = await import("./file-mutation-transaction.js");
  return runtime.captureWorkspaceFilePathTransactionGuard(...args);
}

export async function executeWorkspaceFileMutation(...args: Parameters<Runtime["executeWorkspaceFileMutation"]>): ReturnType<Runtime["executeWorkspaceFileMutation"]> {
  const runtime = await import("./file-mutation-transaction.js");
  return runtime.executeWorkspaceFileMutation(...args);
}
