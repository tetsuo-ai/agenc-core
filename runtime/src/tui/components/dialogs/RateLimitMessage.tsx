import React, { useEffect, useState } from 'react'

import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import {
  getRateLimitTier,
  getSubscriptionType,
  isAgenCAISubscriber,
  isOverageProvisioningAllowed,
} from '../../../utils/auth.js'
import { hasAgenCAiBillingAccess } from '../../../utils/billing.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { Box, Text } from '../../ink.js'
import { MessageResponse } from '../MessageResponse.js'
import { resolveSecureStorageHome } from '../../../utils/secureStorage/home.js'
import { getSelectedProviderEnvironment } from '../../../utils/model/providers.js'

function credentialHome() {
  return resolveSecureStorageHome()
}

type UpsellParams = {
  shouldShowUpsell: boolean
  isMax20x: boolean
  isExtraUsageCommandEnabled: boolean
  shouldAutoOpenRateLimitOptionsMenu: boolean
  isTeamOrEnterprise: boolean
  hasBillingAccess: boolean
}

export function getUpsellMessage({
  shouldShowUpsell,
  isMax20x,
  isExtraUsageCommandEnabled,
  shouldAutoOpenRateLimitOptionsMenu,
  isTeamOrEnterprise,
  hasBillingAccess,
}: UpsellParams): string | null {
  if (!shouldShowUpsell) return null

  if (isMax20x) {
    if (isExtraUsageCommandEnabled) {
      return '/extra-usage to finish what you’re working on.'
    }
    return '/login to switch to an API usage-billed account.'
  }

  if (shouldAutoOpenRateLimitOptionsMenu) {
    return 'Opening your options…'
  }

  if (!isTeamOrEnterprise && !isExtraUsageCommandEnabled) {
    return '/upgrade to increase your usage limit.'
  }

  if (isTeamOrEnterprise) {
    if (!isExtraUsageCommandEnabled) return null
    if (hasBillingAccess) {
      return '/extra-usage to finish what you’re working on.'
    }
    return '/extra-usage to request more usage from your admin.'
  }

  return '/upgrade or /extra-usage to finish what you’re working on.'
}

type RateLimitMessageProps = {
  text: string
  onOpenRateLimitOptions?: () => void
}

function isExtraUsageCommandEnabled(): boolean {
  if (isEnvTruthy(process.env.DISABLE_EXTRA_USAGE_COMMAND)) {
    return false
  }

  return isOverageProvisioningAllowed(credentialHome()) &&
    !getIsNonInteractiveSession()
}

export function RateLimitMessage({
  text,
  onOpenRateLimitOptions,
}: RateLimitMessageProps): React.ReactNode {
  const home = credentialHome()
  const subscriptionType = getSubscriptionType(home)
  const rateLimitTier = getRateLimitTier(home)
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const isMax20x = rateLimitTier === 'default_claude_max_20x'
  const shouldShowUpsell = isAgenCAISubscriber(home)
  const canSeeRateLimitOptionsUpsell = shouldShowUpsell && !isMax20x
  const [hasOpenedInteractiveMenu, setHasOpenedInteractiveMenu] =
    useState(false)
  const shouldAutoOpenRateLimitOptionsMenu =
    canSeeRateLimitOptionsUpsell &&
    !hasOpenedInteractiveMenu &&
    onOpenRateLimitOptions !== undefined

  useEffect(() => {
    if (!shouldAutoOpenRateLimitOptionsMenu || !onOpenRateLimitOptions) {
      return
    }

    setHasOpenedInteractiveMenu(true)
    onOpenRateLimitOptions()
  }, [shouldAutoOpenRateLimitOptionsMenu, onOpenRateLimitOptions])

  const upsell = getUpsellMessage({
    shouldShowUpsell,
    isMax20x,
    isExtraUsageCommandEnabled: isExtraUsageCommandEnabled(),
    shouldAutoOpenRateLimitOptionsMenu,
    isTeamOrEnterprise,
    hasBillingAccess: hasAgenCAiBillingAccess(),
  })

  return (
    <MessageResponse>
      <Box flexDirection="column">
        <Text color="error">{text}</Text>
        {!hasOpenedInteractiveMenu && upsell && (
          <Text dimColor={true}>{upsell}</Text>
        )}
      </Box>
    </MessageResponse>
  )
}
