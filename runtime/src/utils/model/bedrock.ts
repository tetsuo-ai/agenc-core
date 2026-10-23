import type { ProviderEnvironment } from '../../llm/provider-options.js'
import {
  resolveBuiltInProviderRegionalEndpoint,
} from '../../llm/registry/provider-info.js'
import {
  resolveProviderBaseURLEnvironment,
  resolveProviderCredentialEnvironment,
} from '../../llm/registry/provider-ingress.js'
import { getAWSClientProxyConfig } from '../proxy.js'
import { getSelectedProviderEnvironment } from './providers.js'

const AMAZON_BEDROCK_PROVIDER = 'amazon-bedrock'

interface BedrockSdkClientSettings {
  readonly region: string
  readonly runtimeEndpoint: string
  readonly credentials: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
}

/**
 * Project the registry-owned Bedrock environment contract into AWS SDK input.
 * Supplying credentials explicitly prevents the SDK's ambient profile and
 * metadata-provider chains from becoming a second authentication path.
 */
function resolveBedrockSdkClientSettings(
  environment: ProviderEnvironment,
): BedrockSdkClientSettings {
  const credentialResolution = resolveProviderCredentialEnvironment(
    AMAZON_BEDROCK_PROVIDER,
    environment,
  )
  if (credentialResolution?.kind !== 'aws-sigv4') {
    throw new Error('Amazon Bedrock registry metadata is not AWS SigV4')
  }
  if (
    credentialResolution.accessKeyId === undefined ||
    credentialResolution.secretAccessKey === undefined
  ) {
    const missing = credentialResolution.missingRequired
      .map(requirement => requirement.envVars.join(' or '))
      .join(' and ')
    throw new Error(`Amazon Bedrock requires ${missing}`)
  }
  const regionalEndpoint = resolveBuiltInProviderRegionalEndpoint(
    AMAZON_BEDROCK_PROVIDER,
    credentialResolution.region?.value,
  )
  if (regionalEndpoint === undefined) {
    throw new Error('Amazon Bedrock registry has no regional endpoint')
  }
  const endpointOverride = resolveProviderBaseURLEnvironment(
    AMAZON_BEDROCK_PROVIDER,
    environment,
  )
  return Object.freeze({
    region: regionalEndpoint.region,
    runtimeEndpoint: endpointOverride?.value ?? regionalEndpoint.baseURL,
    credentials: Object.freeze({
      accessKeyId: credentialResolution.accessKeyId.value,
      secretAccessKey: credentialResolution.secretAccessKey.value,
      ...(credentialResolution.sessionToken !== undefined
        ? { sessionToken: credentialResolution.sessionToken.value }
        : {}),
    }),
  })
}

export async function createBedrockRuntimeClient() {
  const { BedrockRuntimeClient } = await import(
    '@aws-sdk/client-bedrock-runtime'
  )
  const environment = getSelectedProviderEnvironment()
  const settings = resolveBedrockSdkClientSettings(environment)

  const clientConfig: ConstructorParameters<typeof BedrockRuntimeClient>[0] = {
    region: settings.region,
    endpoint: settings.runtimeEndpoint,
    // AWS SDK annotates credential objects with internal source metadata.
    credentials: { ...settings.credentials },
    ...(await getAWSClientProxyConfig(environment)),
  }

  return new BedrockRuntimeClient(clientConfig)
}

/**
 * Check if a model ID is a foundation model (e.g., "anthropic.claude-sonnet-4-5-20250929-v1:0")
 */
export function isFoundationModel(modelId: string): boolean {
  return modelId.startsWith('anthropic.')
}

/**
 * Cross-region inference profile prefixes for Bedrock.
 * These prefixes allow routing requests to models in specific regions.
 */
const BEDROCK_REGION_PREFIXES = ['us', 'eu', 'apac', 'global'] as const

/**
 * Extract the model/inference profile ID from a Bedrock ARN.
 * If the input is not an ARN, returns it unchanged.
 *
 * ARN format: arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
 * Also handles: arn:aws:bedrock:<region>:<account>:application-inference-profile/<profile-id>
 * And foundation model ARNs: arn:aws:bedrock:<region>::foundation-model/<model-id>
 */
export function extractModelIdFromArn(modelId: string): string {
  if (!modelId.startsWith('arn:')) {
    return modelId
  }
  const lastSlashIndex = modelId.lastIndexOf('/')
  if (lastSlashIndex === -1) {
    return modelId
  }
  return modelId.substring(lastSlashIndex + 1)
}

export type BedrockRegionPrefix = (typeof BEDROCK_REGION_PREFIXES)[number]

/**
 * Extract the region prefix from a Bedrock cross-region inference model ID.
 * Handles both plain model IDs and full ARN format.
 * For example:
 * - "eu.anthropic.claude-sonnet-4-5-20250929-v1:0" → "eu"
 * - "us.anthropic.claude-3-7-sonnet-20250219-v1:0" → "us"
 * - "arn:aws:bedrock:ap-northeast-2:123:inference-profile/global.anthropic.claude-opus-4-6-v1" → "global"
 * - "anthropic.claude-3-5-sonnet-20241022-v2:0" → undefined (foundation model)
 * - "claude-sonnet-4-5-20250929" → undefined (first-party format)
 */
export function getBedrockRegionPrefix(
  modelId: string,
): BedrockRegionPrefix | undefined {
  // Extract the inference profile ID from ARN format if present
  // ARN format: arn:aws:bedrock:<region>:<account>:inference-profile/<profile-id>
  const effectiveModelId = extractModelIdFromArn(modelId)

  for (const prefix of BEDROCK_REGION_PREFIXES) {
    if (effectiveModelId.startsWith(`${prefix}.anthropic.`)) {
      return prefix
    }
  }
  return undefined
}

/**
 * Apply a region prefix to a Bedrock model ID.
 * If the model already has a different region prefix, it will be replaced.
 * If the model is a foundation model (anthropic.*), the prefix will be added.
 * If the model is not a Bedrock model, it will be returned as-is.
 *
 * For example:
 * - applyBedrockRegionPrefix("us.anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("anthropic.claude-sonnet-4-5-v1:0", "eu") → "eu.anthropic.claude-sonnet-4-5-v1:0"
 * - applyBedrockRegionPrefix("claude-sonnet-4-5-20250929", "eu") → "claude-sonnet-4-5-20250929" (not a Bedrock model)
 */
export function applyBedrockRegionPrefix(
  modelId: string,
  prefix: BedrockRegionPrefix,
): string {
  // Check if it already has a region prefix and replace it
  const existingPrefix = getBedrockRegionPrefix(modelId)
  if (existingPrefix) {
    return modelId.replace(`${existingPrefix}.`, `${prefix}.`)
  }

  // Check if it's a foundation model (anthropic.*) and add the prefix
  if (isFoundationModel(modelId)) {
    return `${prefix}.${modelId}`
  }

  // Not a Bedrock model format, return as-is
  return modelId
}
