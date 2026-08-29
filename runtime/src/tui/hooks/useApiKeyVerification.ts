// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { useCallback, useEffect, useRef, useState } from 'react'
import { hasRemoteAuthSessionSync } from '../../auth/session-state.js'
import { verifyApiKey as verifyProviderApiKey } from '../../onboarding/useApiKeyVerification.js'
import type { AgenCConfig } from '../../config/schema.js'
import {
  getAnthropicApiKeyWithSourceForContext,
  isAnthropicAuthEnabledForContext,
  isAgenCAISubscriberForContext,
  type ProviderAuthReadContext,
} from '../../utils/auth.js' // upstream-import: keep target is owned by another Z-PURGE item

export type VerificationStatus =
  | 'loading'
  | 'valid'
  | 'invalid'
  | 'missing'
  | 'error'

export type ApiKeyVerificationResult = {
  status: VerificationStatus
  reverify: () => Promise<void>
  error: Error | null
}

type ApiKeySourceResult = ReturnType<
  typeof getAnthropicApiKeyWithSourceForContext
>

function readApiKeyWithSource(
  context: ProviderAuthReadContext,
): ApiKeySourceResult {
  try {
    return getAnthropicApiKeyWithSourceForContext(context)
  } catch {
    return { key: null, source: 'none' }
  }
}

function getInitialVerificationStatus(
  context: ProviderAuthReadContext,
): VerificationStatus {
  if (hasRemoteAuthSessionSync(context)) {
    return 'valid'
  }
  if (
    !isAnthropicAuthEnabledForContext(context) ||
    isAgenCAISubscriberForContext(context)
  ) {
    return 'valid'
  }
  const { key } = readApiKeyWithSource(context)
  if (key) {
    return 'loading'
  }
  return 'missing'
}

export function useApiKeyVerification(
  context: ProviderAuthReadContext,
  config: AgenCConfig,
): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(
    () => getInitialVerificationStatus(context),
  )
  const [error, setError] = useState<Error | null>(null)
  const verificationRequestIdRef = useRef(0)
  const anthropicVerificationEnabled =
    isAnthropicAuthEnabledForContext(context) &&
    !isAgenCAISubscriberForContext(context) &&
    !hasRemoteAuthSessionSync(context)

  useEffect(() => {
    verificationRequestIdRef.current += 1
    const nextStatus = anthropicVerificationEnabled
      ? getInitialVerificationStatus(context)
      : 'valid'

    setStatus(currentStatus =>
      currentStatus === nextStatus ? currentStatus : nextStatus,
    )
    if (nextStatus !== 'error') {
      setError(null)
    }
  }, [anthropicVerificationEnabled, context])

  useEffect(() => {
    return () => {
      verificationRequestIdRef.current += 1
    }
  }, [])

  const verify = useCallback(async (): Promise<void> => {
    const requestId = verificationRequestIdRef.current + 1
    verificationRequestIdRef.current = requestId
    const isCurrentRequest = () =>
      requestId === verificationRequestIdRef.current

    if (
      !isAnthropicAuthEnabledForContext(context) ||
      isAgenCAISubscriberForContext(context) ||
      hasRemoteAuthSessionSync(context)
    ) {
      setError(null)
      setStatus('valid')
      return
    }
    const { key: apiKey } = readApiKeyWithSource(context)
    if (!apiKey) {
      const newStatus = 'missing'
      setError(null)
      setStatus(newStatus)
      return
    }

    try {
      const verification = await verifyProviderApiKey({
        provider: 'anthropic',
        apiKey,
        config,
        env: context.environment,
      })
      if (verification.status === 'error') {
        throw new Error(
          verification.error ?? 'Anthropic API-key verification failed',
        )
      }
      const isValid = verification.status === 'valid'
      if (!isCurrentRequest()) {
        return
      }

      const newStatus = isValid ? 'valid' : 'invalid'
      setError(null)
      setStatus(newStatus)
      return
    } catch (error) {
      if (!isCurrentRequest()) {
        return
      }

      // This happens when there an error response from the API but it's not an invalid API key error
      // In this case, we still mark the API key as invalid - but we also log the error so we can
      // display it to the user to be more helpful
      setError(error as Error)
      const newStatus = 'error'
      setStatus(newStatus)
      return
    }
  }, [config, context])

  return {
    status,
    reverify: verify,
    error,
  }
}
