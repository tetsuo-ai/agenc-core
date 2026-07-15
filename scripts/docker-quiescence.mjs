const DEFAULT_EMPTY_SAMPLES = 6;
const DEFAULT_SAMPLE_INTERVAL_MS = 2_000;
const DEFAULT_MAX_OBSERVATIONS = 20;

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function assertContainerInventory(value) {
  if (
    !Array.isArray(value) ||
    value.length > 256 ||
    value.some((id) => typeof id !== "string" || !/^[0-9a-f]{64}$/u.test(id)) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Docker returned an unsafe container inventory");
  }
  return Object.freeze([...value]);
}

export async function proveDockerDaemonQuiescence({
  listContainers,
  removeContainers,
  emptySamples = DEFAULT_EMPTY_SAMPLES,
  sampleIntervalMs = DEFAULT_SAMPLE_INTERVAL_MS,
  maxObservations = DEFAULT_MAX_OBSERVATIONS,
  wait = delay,
}) {
  if (
    typeof listContainers !== "function" ||
    (removeContainers !== undefined && typeof removeContainers !== "function") ||
    typeof wait !== "function" ||
    !Number.isSafeInteger(emptySamples) ||
    emptySamples < 2 ||
    !Number.isSafeInteger(sampleIntervalMs) ||
    sampleIntervalMs < 0 ||
    !Number.isSafeInteger(maxObservations) ||
    maxObservations < emptySamples
  ) {
    throw new TypeError("Docker quiescence policy is invalid");
  }

  let consecutiveEmpty = 0;
  const recoveredIds = new Set();
  for (let observation = 0; observation < maxObservations; observation += 1) {
    const containers = assertContainerInventory(await listContainers());
    if (containers.length === 0) {
      consecutiveEmpty += 1;
      if (consecutiveEmpty === emptySamples) {
        return Object.freeze({
          observations: observation + 1,
          recoveredIds: Object.freeze([...recoveredIds].sort()),
        });
      }
    } else {
      if (removeContainers === undefined) {
        throw new Error(
          `dedicated rootless Docker daemon retained ${containers.length} container(s)`,
        );
      }
      await removeContainers(containers);
      for (const id of containers) recoveredIds.add(id);
      consecutiveEmpty = 0;
    }
    await wait(sampleIntervalMs);
  }
  throw new Error("dedicated rootless Docker daemon never reached a stable empty state");
}
