import {
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

const FILE_SYSTEM_OPERATIONS = Object.freeze({
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeFileSync,
});

export function publishBenchmarkArtifacts(artifacts, operationOverrides = {}) {
  const validated = validateArtifacts(artifacts);
  const operations = { ...FILE_SYSTEM_OPERATIONS, ...operationOverrides };
  const ownedArtifacts = [];
  try {
    ownedArtifacts.push(
      createExclusiveArtifact(validated.jsonPath, validated.json, operations),
    );
    ownedArtifacts.push(
      createExclusiveArtifact(
        validated.markdownPath,
        validated.markdown,
        operations,
      ),
    );
    for (const artifact of ownedArtifacts) closeArtifact(artifact, operations);
  } catch (error) {
    const cleanupErrors = [];
    for (const artifact of ownedArtifacts.reverse()) {
      try {
        removeOwnedArtifact(artifact, operations);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "benchmark artifact publication failed and owned-output cleanup was incomplete",
      );
    }
    throw new Error(
      "benchmark artifact publication failed without replacing existing files",
      { cause: error },
    );
  }
}

function createExclusiveArtifact(path, content, operations) {
  const descriptor = operations.openSync(path, "wx", 0o600);
  const artifact = {
    descriptor,
    path,
    closed: false,
    identity: undefined,
  };
  try {
    artifact.identity = fileIdentity(operations.fstatSync(descriptor));
    operations.writeFileSync(descriptor, content, "utf8");
    operations.fsyncSync(descriptor);
    return artifact;
  } catch (error) {
    try {
      removeOwnedArtifact(artifact, operations);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `failed to create and clean partial benchmark artifact ${path}`,
      );
    }
    throw error;
  }
}

function removeOwnedArtifact(artifact, operations) {
  if (artifact.closed) {
    throw new Error(
      `cannot prove ownership while cleaning benchmark artifact ${artifact.path}`,
    );
  }
  if (artifact.identity === undefined) {
    closeArtifact(artifact, operations);
    throw new Error(
      `retained unproven partial benchmark artifact ${artifact.path}`,
    );
  }
  const descriptorIdentity = fileIdentity(
    operations.fstatSync(artifact.descriptor),
  );
  const pathMetadata = operations.lstatSync(artifact.path);
  const pathIdentity = fileIdentity(pathMetadata);
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    !sameFileIdentity(artifact.identity, descriptorIdentity) ||
    !sameFileIdentity(artifact.identity, pathIdentity)
  ) {
    closeArtifact(artifact, operations);
    throw new Error(
      `refused to remove replaced benchmark artifact ${artifact.path}`,
    );
  }
  try {
    operations.unlinkSync(artifact.path);
  } finally {
    closeArtifact(artifact, operations);
  }
}

function closeArtifact(artifact, operations) {
  if (artifact.closed) return;
  operations.closeSync(artifact.descriptor);
  artifact.closed = true;
}

function fileIdentity(metadata) {
  return { device: metadata.dev, inode: metadata.ino };
}

function sameFileIdentity(left, right) {
  return left.device === right.device && left.inode === right.inode;
}

function validateArtifacts(artifacts) {
  if (artifacts === null || typeof artifacts !== "object") {
    throw new Error("benchmark artifacts must be an object");
  }
  for (const name of ["json", "jsonPath", "markdown", "markdownPath"]) {
    if (typeof artifacts[name] !== "string" || artifacts[name].length === 0) {
      throw new Error(`benchmark artifact ${name} must be non-empty`);
    }
  }
  if (artifacts.jsonPath === artifacts.markdownPath) {
    throw new Error("benchmark artifact paths must differ");
  }
  return artifacts;
}
