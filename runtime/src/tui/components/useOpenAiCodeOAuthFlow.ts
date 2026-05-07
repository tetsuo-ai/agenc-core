import * as React from 'react'

import {
  OpenAiCodeOAuthService,
  type OpenAiCodeOAuthTokens,
} from '../../services/api/openAiCodeOAuth.js'
import { openBrowser } from '../../utils/browser' // upstream-import: keep target is owned by another Z-PURGE item
import { saveAgencCredentials } from '../../utils/agencCredentials' // branding-scan: allow upstream mirror import path pending purge // upstream-import: keep target is owned by another Z-PURGE item
import { isBareMode } from '../../utils/envUtils'

export type OpenAiCodeOAuthFlowStatus =
  | { state: 'starting' }
  | {
      state: 'waiting'
      authUrl: string
      browserOpened: boolean | null
    }
  | {
      state: 'error'
      message: string
    }

type PersistOpenAiCodeOAuthCredentials = (options?: {
  profileId?: string
}) => void
type OpenAiCodeOAuthFlowService = OpenAiCodeOAuthService

type OpenAiCodeOAuthFlowDependencies = {
  createOAuthService?: () => Pick<
    OpenAiCodeOAuthFlowService,
    'startOAuthFlow' | 'cleanup'
  >
  openBrowser?: typeof openBrowser
  saveAgencCredentials?: typeof saveAgencCredentials
  isBareMode?: typeof isBareMode
}

function createDefaultOAuthService(): Pick<
  OpenAiCodeOAuthFlowService,
  'startOAuthFlow' | 'cleanup'
> {
  return new OpenAiCodeOAuthService()
}

export function useOpenAiCodeOAuthFlow(options: {
  onAuthenticated: (
    tokens: OpenAiCodeOAuthTokens,
    persistCredentials: PersistOpenAiCodeOAuthCredentials,
  ) => void | Promise<void>
  deps?: OpenAiCodeOAuthFlowDependencies
}): OpenAiCodeOAuthFlowStatus {
  const { onAuthenticated } = options
  const createOAuthService =
    options.deps?.createOAuthService ?? createDefaultOAuthService
  const openBrowserFn = options.deps?.openBrowser ?? openBrowser
  const saveCredentials =
    options.deps?.saveAgencCredentials ?? saveAgencCredentials
  const isBareModeFn = options.deps?.isBareMode ?? isBareMode
  const [status, setStatus] = React.useState<OpenAiCodeOAuthFlowStatus>({
    state: 'starting',
  })

  React.useEffect(() => {
    if (isBareModeFn()) {
      setStatus({
        state: 'error',
        message:
          'Code OAuth is unavailable in --bare because secure storage is disabled.',
      })
      return
    }

    let cancelled = false
    const oauthService = createOAuthService()

    void oauthService
      .startOAuthFlow(async authUrl => {
        if (cancelled) return
        setStatus({
          state: 'waiting',
          authUrl,
          browserOpened: null,
        })
        const browserOpened = await openBrowserFn(authUrl)
        if (cancelled) return
        setStatus({
          state: 'waiting',
          authUrl,
          browserOpened,
        })
      })
      .then(async tokens => {
        if (cancelled) return

        const persistCredentials: PersistOpenAiCodeOAuthCredentials = options => {
          const saved = saveCredentials({
            apiKey: tokens.apiKey,
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            idToken: tokens.idToken,
            accountId: tokens.accountId,
            profileId: options?.profileId,
          })
          if (!saved.success) {
            throw new Error(
              saved.warning ??
                'Code OAuth succeeded, but credentials could not be saved securely.',
            )
          }
        }

        await onAuthenticated(tokens, persistCredentials)
      })
      .catch(error => {
        if (cancelled) return
        setStatus({
          state: 'error',
          message: error instanceof Error ? error.message : String(error),
        })
      })

    return () => {
      cancelled = true
      oauthService.cleanup()
    }
  }, [
    createOAuthService,
    isBareModeFn,
    onAuthenticated,
    openBrowserFn,
    saveCredentials,
  ])

  return status
}
