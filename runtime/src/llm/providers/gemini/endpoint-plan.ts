import { GEMINI_DEVELOPER_NATIVE_BASE_URL } from "../../registry/provider-info.js";

export type GeminiEndpointPlan =
  | Readonly<{
      kind: "developer";
      nativeBaseURL: string;
    }>
  | Readonly<{
      kind: "vertex";
      project: string;
      location: string;
      nativeBaseURL: string;
    }>
  | Readonly<{
      kind: "custom";
      nativeBaseURL: string;
    }>;

export interface GeminiVertexTarget {
  readonly project: string;
  readonly location: string;
}

const DEVELOPER_ENDPOINT = new URL(GEMINI_DEVELOPER_NATIVE_BASE_URL);
const DEVELOPER_HOST = DEVELOPER_ENDPOINT.hostname;
const DEVELOPER_PATH = DEVELOPER_ENDPOINT.pathname;
const GLOBAL_VERTEX_HOST = "aiplatform.googleapis.com";
const REGIONAL_VERTEX_HOST = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)-aiplatform\.googleapis\.com$/u;
const VERTEX_PATH = /^\/v1\/projects\/([^/]+)\/locations\/([^/]+)(?:\/(publishers\/google|endpoints\/openapi))?$/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Gemini endpoint plan requires a non-empty ${field}`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.toLowerCase() === "undefined") {
    throw new Error(`Gemini endpoint plan requires a non-empty ${field}`);
  }
  return normalized;
}

function assertOnlyKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
): void {
  const allowedKeys = new Set(allowed);
  const unsupported = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `Gemini endpoint plan contains unsupported fields: ${unsupported.sort().join(", ")}`,
    );
  }
}

function normalizeVertexTarget(target: GeminiVertexTarget): GeminiVertexTarget {
  const location = requiredString(
    target.location,
    "Vertex location",
  ).toLowerCase();
  if (!/^(?:global|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u.test(location)) {
    throw new Error("Gemini Vertex location is not a valid region identifier");
  }
  return Object.freeze({
    project: requiredString(target.project, "Vertex project"),
    location,
  });
}

function vertexHost(location: string): string {
  return location === "global"
    ? GLOBAL_VERTEX_HOST
    : `${location}-aiplatform.googleapis.com`;
}

function createVertexEndpointPlan(
  target: GeminiVertexTarget,
): Extract<GeminiEndpointPlan, { kind: "vertex" }> {
  const normalized = normalizeVertexTarget(target);
  const resourceRoot =
    `https://${vertexHost(normalized.location)}/v1/projects/` +
    `${encodeURIComponent(normalized.project)}/locations/` +
    encodeURIComponent(normalized.location);
  return Object.freeze({
    kind: "vertex",
    ...normalized,
    nativeBaseURL: `${resourceRoot}/publishers/google`,
  });
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (!/^127(?:\.\d{1,3}){3}$/u.test(normalized)) return false;
  return normalized.split(".").slice(1).every((part) => Number(part) <= 255);
}

function parseEndpointURL(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(requiredString(value, "baseURL"));
  } catch {
    throw new Error("Gemini endpoint baseURL must be an absolute URL");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("Gemini endpoint baseURL cannot contain credentials");
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error("Gemini endpoint baseURL cannot contain a query or fragment");
  }
  if (
    parsed.protocol !== "https:" &&
    !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname))
  ) {
    throw new Error(
      "Gemini endpoint baseURL must use HTTPS unless it targets loopback",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/u, "") || "/";
  const operationPath = parsed.pathname.toLowerCase();
  if (
    operationPath.endsWith("/chat/completions") ||
    operationPath.endsWith("/responses") ||
    operationPath.endsWith("/models") ||
    /:(?:generatecontent|streamgeneratecontent|counttokens)$/u.test(operationPath)
  ) {
    throw new Error(
      "Gemini endpoint baseURL must identify an API root, not an operation URL",
    );
  }
  return parsed;
}

function parseVertexURL(
  parsed: URL,
): { readonly target: GeminiVertexTarget; readonly matched: boolean } {
  const pathMatch = VERTEX_PATH.exec(parsed.pathname);
  const regionalMatch = REGIONAL_VERTEX_HOST.exec(parsed.hostname);
  const isGlobalHost = parsed.hostname === GLOBAL_VERTEX_HOST;
  const looksLikeVertex =
    regionalMatch !== null || isGlobalHost || pathMatch !== null;
  if (!looksLikeVertex) {
    return { target: { project: "", location: "" }, matched: false };
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port.length > 0 ||
    pathMatch === null
  ) {
    throw new Error("Gemini Vertex baseURL has an invalid resource path");
  }
  let project: string;
  let location: string;
  try {
    project = decodeURIComponent(pathMatch[1]!);
    location = decodeURIComponent(pathMatch[2]!).toLowerCase();
  } catch {
    throw new Error("Gemini Vertex baseURL contains invalid path encoding");
  }
  if (pathMatch[3] === "endpoints/openapi") {
    throw new Error(
      "GEMINI_BASE_URL must use the native Gemini protocol, not a Vertex OpenAI-compatible endpoint",
    );
  }
  if (location === "global") {
    if (!isGlobalHost) {
      throw new Error(
        "Gemini Vertex global location must use aiplatform.googleapis.com",
      );
    }
  } else if (regionalMatch?.[1] !== location) {
    throw new Error(
      "Gemini Vertex hostname region must match its resource-path location",
    );
  }
  return {
    target: normalizeVertexTarget({ project, location }),
    matched: true,
  };
}

function assertMatchingVertexTarget(
  embedded: GeminiVertexTarget,
  explicit: GeminiVertexTarget | undefined,
): void {
  if (explicit === undefined) return;
  const normalized = normalizeVertexTarget(explicit);
  if (
    normalized.project !== embedded.project ||
    normalized.location !== embedded.location
  ) {
    throw new Error(
      "Gemini Vertex baseURL conflicts with the configured project/location",
    );
  }
}

export function createGeminiEndpointPlan(input: {
  readonly baseURL?: string;
  readonly vertex?: GeminiVertexTarget;
} = {}): GeminiEndpointPlan {
  const rawBaseURL = input.baseURL?.trim();
  if (rawBaseURL === undefined || rawBaseURL.length === 0) {
    return input.vertex === undefined
      ? Object.freeze({
          kind: "developer",
          nativeBaseURL: GEMINI_DEVELOPER_NATIVE_BASE_URL,
        })
      : createVertexEndpointPlan(input.vertex);
  }
  if (rawBaseURL.toLowerCase() === "undefined") {
    throw new Error('Gemini endpoint baseURL cannot be the literal "undefined"');
  }

  const parsed = parseEndpointURL(rawBaseURL);
  if (parsed.hostname === DEVELOPER_HOST) {
    if (
      parsed.protocol !== "https:" ||
      parsed.port.length > 0 ||
      parsed.pathname !== DEVELOPER_PATH
    ) {
      throw new Error(
        "Gemini Developer API baseURL must use the native /v1beta endpoint",
      );
    }
    if (input.vertex !== undefined) {
      throw new Error(
        "Gemini Developer API baseURL cannot also declare a Vertex target",
      );
    }
    return Object.freeze({
      kind: "developer",
      nativeBaseURL: GEMINI_DEVELOPER_NATIVE_BASE_URL,
    });
  }

  const vertex = parseVertexURL(parsed);
  if (vertex.matched) {
    assertMatchingVertexTarget(vertex.target, input.vertex);
    return createVertexEndpointPlan(vertex.target);
  }
  if (input.vertex !== undefined) {
    throw new Error("A custom Gemini baseURL cannot also declare a Vertex target");
  }
  if (parsed.hostname.includes("googleapis.com")) {
    throw new Error("Gemini endpoint baseURL uses an unrecognized Google API host");
  }

  if (/\/openai$/iu.test(parsed.pathname)) {
    throw new Error(
      "GEMINI_BASE_URL must identify a native Gemini endpoint, not an OpenAI-compatible endpoint",
    );
  }
  const normalized = parsed.toString().replace(/\/$/u, "");
  return Object.freeze({
    kind: "custom",
    nativeBaseURL: normalized,
  });
}

export function parseGeminiEndpointPlan(value: unknown): GeminiEndpointPlan {
  if (!isRecord(value)) {
    throw new Error("Gemini runtime options require an endpointPlan");
  }
  const commonKeys = ["kind", "nativeBaseURL"];
  const kind = value.kind;
  if (kind !== "developer" && kind !== "vertex" && kind !== "custom") {
    throw new Error("Gemini endpoint plan has an invalid kind");
  }
  assertOnlyKeys(
    value,
    kind === "vertex" ? [...commonKeys, "project", "location"] : commonKeys,
  );
  const nativeBaseURL = requiredString(value.nativeBaseURL, "nativeBaseURL");
  const parsed = kind === "vertex"
    ? createGeminiEndpointPlan({
        baseURL: nativeBaseURL,
        vertex: {
          project: requiredString(value.project, "Vertex project"),
          location: requiredString(value.location, "Vertex location"),
        },
      })
    : createGeminiEndpointPlan({ baseURL: nativeBaseURL });
  if (
    parsed.kind !== kind ||
    parsed.nativeBaseURL !== nativeBaseURL
  ) {
    throw new Error("Gemini endpoint plan URL is not canonical");
  }
  return parsed;
}

export function geminiEndpointFor(
  plan: GeminiEndpointPlan,
): string {
  return plan.nativeBaseURL;
}

function bareGeminiModel(model: string): string {
  return requiredString(model, "model")
    .replace(/^gemini:/iu, "")
    .replace(/^publishers\/google\/models\//iu, "")
    .replace(/^models\//iu, "")
    .replace(/^google\//iu, "");
}

export function canonicalGeminiModelName(model: string): string {
  return bareGeminiModel(model);
}
