// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { useCallback, useEffect, useRef, useState } from 'react'
import { getIsNonInteractiveSession } from '../../bootstrap/state.js'
import { hasRemoteAuthSessionSync } from '../../auth/session-state.js'
import { verifyApiKey } from '../../services/api/anthropic.js' // branding-scan: allow upstream mirror import path pending purge
import {
  getAnthropicApiKeyWithSource,
  getApiKeyFromApiKeyHelper,
  isAnthropicAuthEnabled,
  isAgenCAISubscriber,
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

type ApiKeySourceResult = ReturnType<typeof getAnthropicApiKeyWithSource>

function readApiKeyWithSource(
  opts?: Parameters<typeof getAnthropicApiKeyWithSource>[0],
): ApiKeySourceResult {
  try {
    return opts === undefined
      ? getAnthropicApiKeyWithSource()
      : getAnthropicApiKeyWithSource(opts)
  } catch {
    return { key: null, source: 'none' }
  }
}

function getInitialVerificationStatus(): VerificationStatus {
  if (hasRemoteAuthSessionSync()) {
    return 'valid'
  }
  if (!isAnthropicAuthEnabled() || isAgenCAISubscriber()) {
    return 'valid'
  }
  // Use skipRetrievingKeyFromApiKeyHelper to avoid executing apiKeyHelper
  // before trust dialog is shown (security: prevents RCE via settings.json)
  const { key, source } = readApiKeyWithSource({
    skipRetrievingKeyFromApiKeyHelper: true,
  })
  // If apiKeyHelper is configured, we have a key source even though we
  // haven't executed it yet - return 'loading' to indicate we'll verify later
  if (key || source === 'apiKeyHelper') {
    return 'loading'
  }
  return 'missing'
}

export function useApiKeyVerification(): ApiKeyVerificationResult {
  const [status, setStatus] = useState<VerificationStatus>(
    getInitialVerificationStatus,
  )
  const [error, setError] = useState<Error | null>(null)
  const verificationRequestIdRef = useRef(0)
  const anthropicVerificationEnabled =
    isAnthropicAuthEnabled() && !isAgenCAISubscriber() && !hasRemoteAuthSessionSync()

  useEffect(() => {
    verificationRequestIdRef.current += 1
    const nextStatus = anthropicVerificationEnabled
      ? getInitialVerificationStatus()
      : 'valid'

    setStatus(currentStatus =>
      currentStatus === nextStatus ? currentStatus : nextStatus,
    )
    if (nextStatus !== 'error') {
      setError(null)
    }
  }, [anthropicVerificationEnabled])

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

    if (!isAnthropicAuthEnabled() || isAgenCAISubscriber() || hasRemoteAuthSessionSync()) {
      setError(null)
      setStatus('valid')
      return
    }
    // Warm the apiKeyHelper cache (no-op if not configured), then read from
    // all sources. getAnthropicApiKeyWithSource() reads the now-warm cache.
    await getApiKeyFromApiKeyHelper(getIsNonInteractiveSession())
    if (!isCurrentRequest()) {
      return
    }

    const { key: apiKey, source } = readApiKeyWithSource()
    if (!apiKey) {
      if (source === 'apiKeyHelper') {
        setStatus('error')
        setError(new Error('API key helper did not return a valid key'))
        return
      }
      const newStatus = 'missing'
      setError(null)
      setStatus(newStatus)
      return
    }

    try {
      const isValid = await verifyApiKey(apiKey, false)
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
  }, [])

  return {
    status,
    reverify: verify,
    error,
  }
}
