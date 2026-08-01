import { createHash, createHmac } from "node:crypto";
import { readSync } from "node:fs";
import { registerHooks } from "node:module";
import { inflateRawSync } from "node:zlib";

const BOOTSTRAP_ENVIRONMENT_VARIABLE = "AGENC_RED_PROBE_BOOTSTRAP_V1";
const EXPECTED_EXIT_CODE = 86;
const PROTOCOL_OUTCOME = "expected-red";
const PROTOCOL_PREFIX = "AGENC_RED_PROBE_V1 ";
const HEARTBEAT_PROTOCOL_OUTCOME = "heartbeat";
const HEARTBEAT_PROTOCOL_PREFIX = "AGENC_RED_PROBE_HEARTBEAT_V1 ";
const PROTOCOL_VERSION = 1;
const HEARTBEAT_INTERVAL_MS = 1_000;
const AUTHENTICATION_SECRET_BYTES = 32;
const HANDOFF_MAGIC = Buffer.from("AGENC_RED_PROBE_HANDOFF_V1\0", "ascii");
const FINAL_AUTHENTICATION_DOMAIN = "AGENC_RED_PROBE_FINAL_V1\0";
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const MAXIMUM_HELPER_BYTES = 65_536;
const MAXIMUM_COMPRESSED_HELPER_BYTES = MAXIMUM_HELPER_BYTES + 1_024;
const MAXIMUM_PROBE_BYTES = 65_536;
const MAXIMUM_HANDOFF_BYTES =
  HANDOFF_MAGIC.byteLength + AUTHENTICATION_SECRET_BYTES + MAXIMUM_PROBE_BYTES;
const HELPER_FACTORY = "createRedProbeAssertion";
const CONFIGURATION_KEYS = Object.freeze([
  "fingerprint",
  "heartbeatIntervalMs",
  "helperRequestUrl",
  "helperSourceDeflateBase64",
  "helperSourceSha256",
  "helperSourceUrl",
  "id",
  "networkTripwireUrl",
  "probeSourceSha256",
  "probeSourceUrl",
  "task",
  "tsxLoaderUrl",
]);
const IDENTITY_KEYS = Object.freeze(["fingerprint", "id", "task"]);
const createObject = Object.create;
const createHmacSha256 = createHmac;
const freeze = Object.freeze;
const hasOwn = Object.hasOwn;
const isArray = Array.isArray;
const keys = Object.keys;
const parseJson = JSON.parse;
const cancelInterval = clearInterval;
const scheduleInterval = setInterval;
const stringifyJson = JSON.stringify;
const writeStandardOutput = process.stdout.write.bind(process.stdout);

function hasExactKeys(value, expectedKeys) {
  if (value === null || typeof value !== "object" || isArray(value)) {
    return false;
  }
  const actualKeys = keys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  for (let index = 0; index < expectedKeys.length; index += 1) {
    const key = expectedKeys[index];
    if (!hasOwn(value, key)) return false;
  }
  return true;
}

function decodeCanonicalBase64(encoded, maximumBytes, label) {
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error(`${label} is missing`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maximumBytes ||
    bytes.toString("base64") !== encoded
  ) {
    throw new Error(`${label} is invalid`);
  }
  return bytes;
}

function inflateHelperSource(encoded) {
  const compressed = decodeCanonicalBase64(
    encoded,
    MAXIMUM_COMPRESSED_HELPER_BYTES,
    "red-probe compressed helper source",
  );
  let source;
  try {
    source = inflateRawSync(compressed, {
      maxOutputLength: MAXIMUM_HELPER_BYTES,
    });
  } catch {
    throw new Error("red-probe compressed helper source is invalid");
  }
  if (source.byteLength === 0) {
    throw new Error("red-probe helper source is missing");
  }
  return source;
}

function parseCanonicalFileUrl(value, label, extension) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.protocol !== "file:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(`/tests/helpers/red-probe.${extension}`) ||
    url.href !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return url.href;
}

function parseCanonicalProbeSourceUrl(value) {
  if (typeof value !== "string") {
    throw new Error("red-probe source URL is invalid");
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("red-probe source URL is invalid");
  }
  if (
    url.protocol !== "file:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith("/[eval1].ts") ||
    url.href !== value
  ) {
    throw new Error("red-probe source URL is invalid");
  }
  return url.href;
}

function parseCanonicalSupportUrl(value, label, pathnameSuffix) {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (
    url.protocol !== "file:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.endsWith(pathnameSuffix) ||
    url.href !== value
  ) {
    throw new Error(`${label} is invalid`);
  }
  return url.href;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function loadConfiguration() {
  const encoded = process.env[BOOTSTRAP_ENVIRONMENT_VARIABLE];
  delete process.env[BOOTSTRAP_ENVIRONMENT_VARIABLE];
  if (typeof encoded !== "string" || encoded.length === 0) {
    throw new Error("red-probe bootstrap configuration is missing");
  }

  let value;
  try {
    value = parseJson(encoded);
  } catch {
    throw new Error("red-probe bootstrap configuration is invalid");
  }
  if (
    !hasExactKeys(value, CONFIGURATION_KEYS) ||
    !SHA256_PATTERN.test(value.helperSourceSha256) ||
    typeof value.fingerprint !== "string" ||
    value.heartbeatIntervalMs !== HEARTBEAT_INTERVAL_MS ||
    typeof value.id !== "string" ||
    !SHA256_PATTERN.test(value.probeSourceSha256) ||
    typeof value.task !== "string"
  ) {
    throw new Error("red-probe bootstrap configuration is invalid");
  }
  const helperSource = inflateHelperSource(value.helperSourceDeflateBase64);
  if (sha256(helperSource) !== value.helperSourceSha256) {
    throw new Error("red-probe helper source digest does not match");
  }
  return freeze({
    fingerprint: value.fingerprint,
    heartbeatIntervalMs: value.heartbeatIntervalMs,
    helperRequestUrl: parseCanonicalFileUrl(
      value.helperRequestUrl,
      "red-probe helper request URL",
      "js",
    ),
    helperSource,
    helperSourceUrl: parseCanonicalFileUrl(
      value.helperSourceUrl,
      "red-probe helper source URL",
      "ts",
    ),
    id: value.id,
    networkTripwireUrl: parseCanonicalSupportUrl(
      value.networkTripwireUrl,
      "red-probe network tripwire URL",
      "/tests/helpers/network-tripwire.cjs",
    ),
    probeSourceSha256: value.probeSourceSha256,
    probeSourceUrl: parseCanonicalProbeSourceUrl(value.probeSourceUrl),
    task: value.task,
    tsxLoaderUrl: parseCanonicalSupportUrl(
      value.tsxLoaderUrl,
      "red-probe TypeScript loader URL",
      "/node_modules/tsx/dist/loader.mjs",
    ),
  });
}

function identityMatches(configuration, identity) {
  return (
    hasExactKeys(identity, IDENTITY_KEYS) &&
    identity.fingerprint === configuration.fingerprint &&
    identity.id === configuration.id &&
    identity.task === configuration.task
  );
}

function readBoundedBootstrapHandoff() {
  const bytes = Buffer.allocUnsafe(MAXIMUM_HANDOFF_BYTES + 1);
  let bytesRead = 0;
  while (bytesRead < bytes.byteLength) {
    const count = readSync(
      0,
      bytes,
      bytesRead,
      bytes.byteLength - bytesRead,
      null,
    );
    if (count === 0) break;
    bytesRead += count;
  }
  if (bytesRead > MAXIMUM_HANDOFF_BYTES) {
    throw new Error("red-probe bootstrap handoff exceeds its bound");
  }
  return bytes.subarray(0, bytesRead);
}

function consumeBootstrapHandoff(configuration) {
  const handoff = readBoundedBootstrapHandoff();
  const sourceOffset = HANDOFF_MAGIC.byteLength + AUTHENTICATION_SECRET_BYTES;
  if (
    handoff.byteLength <= sourceOffset ||
    !handoff.subarray(0, HANDOFF_MAGIC.byteLength).equals(HANDOFF_MAGIC)
  ) {
    throw new Error("red-probe bootstrap handoff is invalid");
  }
  const authenticationSecret = Buffer.from(
    handoff.subarray(HANDOFF_MAGIC.byteLength, sourceOffset),
  );
  const probeSource = Buffer.from(handoff.subarray(sourceOffset));
  handoff.fill(0);
  if (authenticationSecret.byteLength !== AUTHENTICATION_SECRET_BYTES) {
    throw new Error("red-probe authentication secret is invalid");
  }
  if (
    probeSource.byteLength === 0 ||
    probeSource.byteLength > MAXIMUM_PROBE_BYTES
  ) {
    throw new Error("red-probe source exceeds its bootstrap bound");
  }
  if (sha256(probeSource) !== configuration.probeSourceSha256) {
    throw new Error("red-probe source digest does not match its bootstrap");
  }
  return freeze({ authenticationSecret, probeSource });
}

const configuration = loadConfiguration();
// Consume the supervisor-owned authentication secret before any
// filesystem-backed module, external loader, or probe dependency runs. The
// pipe is at EOF before that module graph is admitted, and the secret remains
// only in this closure.
const { authenticationSecret, probeSource } =
  consumeBootstrapHandoff(configuration);
await import(configuration.networkTripwireUrl);
await import(configuration.tsxLoaderUrl);
let expectedFailureReported = false;

function reportExpectedFailure(identity) {
  if (expectedFailureReported) {
    throw new Error("red-probe expected failure may only be reported once");
  }
  if (!identityMatches(configuration, identity)) {
    throw new Error(
      "red-probe assertion identity does not match its bootstrap",
    );
  }
  expectedFailureReported = true;
}

function isExactHelperUrl(url) {
  return (
    url === configuration.helperRequestUrl ||
    url === configuration.helperSourceUrl
  );
}

function assertAuthorizedHelperParent(parentUrl) {
  if (parentUrl !== import.meta.url) {
    throw new Error("red-probe helper import has an unauthorized parent");
  }
}

const helperHooks = registerHooks({
  load(url, context, nextLoad) {
    if (url === configuration.helperSourceUrl) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: configuration.helperSource,
      };
    }
    if (url === configuration.probeSourceUrl) {
      return {
        format: "module-typescript",
        shortCircuit: true,
        source: probeSource,
      };
    }
    return nextLoad(url, context);
  },
  resolve(specifier, context, nextResolve) {
    let requestedUrl;
    try {
      requestedUrl = context.parentURL
        ? new URL(specifier, context.parentURL).href
        : new URL(specifier).href;
    } catch {
      requestedUrl = undefined;
    }
    if (requestedUrl === configuration.probeSourceUrl) {
      if (context.parentURL !== import.meta.url) {
        throw new Error("red-probe source import has an unauthorized parent");
      }
      return {
        shortCircuit: true,
        url: configuration.probeSourceUrl,
      };
    }
    if (requestedUrl !== undefined && isExactHelperUrl(requestedUrl)) {
      assertAuthorizedHelperParent(context.parentURL);
      return {
        shortCircuit: true,
        url: configuration.helperSourceUrl,
      };
    }
    const resolved = nextResolve(specifier, context);
    if (isExactHelperUrl(resolved.url)) {
      assertAuthorizedHelperParent(context.parentURL);
      return {
        ...resolved,
        shortCircuit: true,
        url: configuration.helperSourceUrl,
      };
    }
    return resolved;
  },
});

let helperModule;
try {
  helperModule = await import(configuration.helperSourceUrl);
} catch (error) {
  throw error;
}
if (typeof helperModule[HELPER_FACTORY] !== "function") {
  throw new Error("red-probe helper does not export its canonical factory");
}
const probeAssertion = helperModule[HELPER_FACTORY](reportExpectedFailure);

let heartbeatSequence = 0;
function writeHeartbeat() {
  heartbeatSequence += 1;
  const evidence = createObject(null);
  evidence.protocolVersion = PROTOCOL_VERSION;
  evidence.outcome = HEARTBEAT_PROTOCOL_OUTCOME;
  evidence.id = configuration.id;
  evidence.task = configuration.task;
  evidence.fingerprint = configuration.fingerprint;
  evidence.sequence = heartbeatSequence;
  writeStandardOutput(
    `${HEARTBEAT_PROTOCOL_PREFIX}${stringifyJson(evidence)}\n`,
  );
}

writeHeartbeat();
const heartbeatTimer = scheduleInterval(
  writeHeartbeat,
  configuration.heartbeatIntervalMs,
);
heartbeatTimer.unref();

function emitAuthenticatedExpectedRedResult() {
  cancelInterval(heartbeatTimer);
  if (!expectedFailureReported) return;
  if (process.exitCode !== undefined && process.exitCode !== 0) return;
  const evidence = createObject(null);
  evidence.protocolVersion = PROTOCOL_VERSION;
  evidence.outcome = PROTOCOL_OUTCOME;
  evidence.id = configuration.id;
  evidence.task = configuration.task;
  evidence.fingerprint = configuration.fingerprint;
  evidence.assertions = 1;
  evidence.skipped = 0;
  evidence.todos = 0;
  const authenticationTag = createHmacSha256("sha256", authenticationSecret)
    .update(FINAL_AUTHENTICATION_DOMAIN, "utf8")
    .update(stringifyJson(evidence), "utf8")
    .digest("hex");
  const authenticatedEvidence = createObject(null);
  for (const key of keys(evidence)) authenticatedEvidence[key] = evidence[key];
  authenticatedEvidence.authenticationTag = authenticationTag;
  writeStandardOutput(
    `${PROTOCOL_PREFIX}${stringifyJson(authenticatedEvidence)}\n`,
  );
  process.exitCode = EXPECTED_EXIT_CODE;
}

const probeModule = await import(configuration.probeSourceUrl);
if (
  keys(probeModule).length !== 1 ||
  !hasOwn(probeModule, "default") ||
  typeof probeModule.default !== "function"
) {
  throw new Error("red-probe source does not export one canonical root runner");
}
await probeModule.default(probeAssertion);
emitAuthenticatedExpectedRedResult();

void helperHooks;

//# sourceURL=agenc-red-probe-bootstrap.mjs
