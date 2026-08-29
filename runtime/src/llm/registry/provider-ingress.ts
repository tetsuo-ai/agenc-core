import {
  resolveBuiltInProviderInfo,
  type BuiltInProviderInfo,
  type ProviderCredentialFieldDefinition,
} from "./provider-info.js";

export type ProviderIngressEnvironment = Readonly<
  Record<string, string | undefined>
>;

export interface ProviderEnvironmentMatch {
  readonly envVar: string;
  readonly value: string;
}

export type ProviderCredentialFieldRole =
  | "apiKey"
  | "accessKeyId"
  | "secretAccessKey"
  | "sessionToken"
  | "region";

export type ProviderAwsSigV4FieldRole = Exclude<
  ProviderCredentialFieldRole,
  "apiKey"
>;
export type ProviderAwsSigV4RequiredFieldRole = Extract<
  ProviderAwsSigV4FieldRole,
  "accessKeyId" | "secretAccessKey"
>;

export interface ProviderCredentialEnvironmentSource<
  Role extends ProviderCredentialFieldRole = ProviderCredentialFieldRole,
>
  extends ProviderEnvironmentMatch {
  readonly role: Role;
}

export interface ProviderCredentialEnvironmentRequirement<
  Role extends ProviderCredentialFieldRole = ProviderCredentialFieldRole,
> {
  readonly role: Role;
  readonly envVars: readonly string[];
}

export interface ProviderCredentialEnvironmentReference {
  readonly role: ProviderCredentialFieldRole;
  readonly envVar: string;
}

export interface ProviderCredentialEnvironmentProvenance {
  readonly kind: "environment";
  readonly fields: readonly ProviderCredentialEnvironmentReference[];
}

export type ProviderCredentialProvenance =
  | ProviderCredentialEnvironmentProvenance
  | { readonly kind: "oauth"; readonly provider: "grok" };

export const GROK_OAUTH_CREDENTIAL_PROVENANCE: Extract<
  ProviderCredentialProvenance,
  { readonly kind: "oauth" }
> = Object.freeze({ kind: "oauth", provider: "grok" });

export type ProviderCredentialEnvironmentResolution =
  | {
      readonly kind: "none";
      readonly sources: readonly never[];
      readonly missingRequired: readonly never[];
    }
  | {
      readonly kind: "api-key";
      readonly apiKey?: ProviderCredentialEnvironmentSource<"apiKey">;
      readonly sources: readonly ProviderCredentialEnvironmentSource<
        "apiKey"
      >[];
      readonly missingRequired: readonly ProviderCredentialEnvironmentRequirement<
        "apiKey"
      >[];
    }
  | {
      readonly kind: "aws-sigv4";
      readonly accessKeyId?: ProviderCredentialEnvironmentSource<
        "accessKeyId"
      >;
      readonly secretAccessKey?: ProviderCredentialEnvironmentSource<
        "secretAccessKey"
      >;
      readonly sessionToken?: ProviderCredentialEnvironmentSource<
        "sessionToken"
      >;
      readonly region?: ProviderCredentialEnvironmentSource<"region">;
      readonly sources: readonly ProviderCredentialEnvironmentSource<
        ProviderAwsSigV4FieldRole
      >[];
      readonly missingRequired: readonly ProviderCredentialEnvironmentRequirement<
        ProviderAwsSigV4RequiredFieldRole
      >[];
    };

function firstEnvironmentMatch(
  env: ProviderIngressEnvironment,
  names: readonly string[],
): ProviderEnvironmentMatch | undefined {
  for (const envVar of names) {
    const value = env[envVar]?.trim();
    if (value && value.toLowerCase() !== "undefined") {
      return Object.freeze({ envVar, value });
    }
  }
  return undefined;
}

function credentialFieldMatch<Role extends ProviderCredentialFieldRole>(
  env: ProviderIngressEnvironment,
  role: Role,
  field: ProviderCredentialFieldDefinition,
): ProviderCredentialEnvironmentSource<Role> | undefined {
  const match = firstEnvironmentMatch(env, field.envVars);
  return match === undefined
    ? undefined
    : Object.freeze({ role, ...match });
}

function missingCredentialRequirement<Role extends ProviderCredentialFieldRole>(
  role: Role,
  field: ProviderCredentialFieldDefinition,
): ProviderCredentialEnvironmentRequirement<Role> {
  return Object.freeze({ role, envVars: field.envVars });
}

function resolveProviderInfo(
  provider: string,
): BuiltInProviderInfo | undefined {
  return resolveBuiltInProviderInfo(provider);
}

/** Resolve every environment-backed credential field from registry metadata. */
export function resolveProviderCredentialEnvironment(
  provider: string,
  env: ProviderIngressEnvironment,
): ProviderCredentialEnvironmentResolution | undefined {
  const info = resolveProviderInfo(provider);
  if (info === undefined) return undefined;
  const credentials = info.credentials;
  if (credentials.kind === "none") {
    return Object.freeze({
      kind: "none",
      sources: Object.freeze([]),
      missingRequired: Object.freeze([]),
    });
  }
  if (credentials.kind === "api-key") {
    const apiKey = credentialFieldMatch(
      env,
      "apiKey",
      credentials.apiKey,
    );
    return Object.freeze({
      kind: "api-key",
      ...(apiKey !== undefined ? { apiKey } : {}),
      sources: Object.freeze(apiKey === undefined ? [] : [apiKey]),
      missingRequired: Object.freeze(
        credentials.apiKey.required && apiKey === undefined
          ? [missingCredentialRequirement("apiKey", credentials.apiKey)]
          : [],
      ),
    });
  }

  const accessKeyId = credentialFieldMatch(
    env,
    "accessKeyId",
    credentials.accessKeyId,
  );
  const secretAccessKey = credentialFieldMatch(
    env,
    "secretAccessKey",
    credentials.secretAccessKey,
  );
  const sessionToken = credentialFieldMatch(
    env,
    "sessionToken",
    credentials.sessionToken,
  );
  const regionMatch = firstEnvironmentMatch(env, credentials.regionEnvVars);
  const region = regionMatch === undefined
    ? undefined
    : Object.freeze({ role: "region" as const, ...regionMatch });
  const sources: ProviderCredentialEnvironmentSource<
    ProviderAwsSigV4FieldRole
  >[] = [accessKeyId, secretAccessKey, sessionToken, region].filter(
    (
      source,
    ): source is ProviderCredentialEnvironmentSource<
      ProviderAwsSigV4FieldRole
    > => source !== undefined,
  );
  const missingRequired: ProviderCredentialEnvironmentRequirement<
    ProviderAwsSigV4RequiredFieldRole
  >[] = [];
  if (credentials.accessKeyId.required && accessKeyId === undefined) {
    missingRequired.push(
      missingCredentialRequirement("accessKeyId", credentials.accessKeyId),
    );
  }
  if (credentials.secretAccessKey.required && secretAccessKey === undefined) {
    missingRequired.push(
      missingCredentialRequirement(
        "secretAccessKey",
        credentials.secretAccessKey,
      ),
    );
  }
  return Object.freeze({
    kind: "aws-sigv4",
    ...(accessKeyId !== undefined ? { accessKeyId } : {}),
    ...(secretAccessKey !== undefined ? { secretAccessKey } : {}),
    ...(sessionToken !== undefined ? { sessionToken } : {}),
    ...(region !== undefined ? { region } : {}),
    sources: Object.freeze(sources),
    missingRequired: Object.freeze(missingRequired),
  });
}

/** Describe the required credential fields still absent from the environment. */
export function missingProviderCredentialEnvironmentLabel(
  provider: string,
  env: ProviderIngressEnvironment,
): string | undefined {
  const resolution = resolveProviderCredentialEnvironment(provider, env);
  if (resolution === undefined || resolution.missingRequired.length === 0) {
    return undefined;
  }
  return resolution.missingRequired
    .map((requirement) => requirement.envVars.join(" or "))
    .join(" and ");
}

/** Redact resolved credential values into canonical, exact provenance. */
export function providerCredentialEnvironmentProvenance(
  resolution: ProviderCredentialEnvironmentResolution,
): ProviderCredentialEnvironmentProvenance | undefined {
  if (resolution.sources.length === 0) return undefined;
  return Object.freeze({
    kind: "environment",
    fields: Object.freeze(
      resolution.sources.map(({ role, envVar }) =>
        Object.freeze({ role, envVar })
      ),
    ),
  });
}

/** Resolve the first non-empty API-key alias in canonical provider order. */
export function resolveProviderApiKeyEnvironment(
  provider: string,
  env: ProviderIngressEnvironment,
): ProviderEnvironmentMatch | undefined {
  const resolution = resolveProviderCredentialEnvironment(provider, env);
  const match = resolution?.kind === "api-key"
    ? resolution.apiKey
    : undefined;
  return match === undefined
    ? undefined
    : Object.freeze({ envVar: match.envVar, value: match.value });
}

/** Resolve the first non-empty endpoint alias in canonical provider order. */
export function resolveProviderBaseURLEnvironment(
  provider: string,
  env: ProviderIngressEnvironment,
): ProviderEnvironmentMatch | undefined {
  const info = resolveProviderInfo(provider);
  return info === undefined
    ? undefined
    : firstEnvironmentMatch(env, info.baseURLEnvVars);
}
