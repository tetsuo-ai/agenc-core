import React, { useEffect, useState } from 'react'

import { getIsNonInteractiveSession } from '../../../bootstrap/state.js'
import { shouldProcessMockLimits } from '../../../services/rateLimitMocking.js'
import {
  getRateLimitTier,
  getSubscriptionType,
  isAgenCAISubscriber,
  isOverageProvisioningAllowed,
} from '../../../utils/auth.js'
import { hasAgenCAiBillingAccess } from '../../../utils/billing.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { Box, Text } from '../../ink.js'
import { useAgenCAiLimits } from '../../rate-limits/agenc-ai-limits.js'
import { MessageResponse } from '../MessageResponse.js'

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

  return isOverageProvisioningAllowed() && !getIsNonInteractiveSession()
}

export function RateLimitMessage({
  text,
  onOpenRateLimitOptions,
}: RateLimitMessageProps): React.ReactNode {
  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()
  const isTeamOrEnterprise =
    subscriptionType === 'team' || subscriptionType === 'enterprise'
  const isMax20x = rateLimitTier === 'default_claude_max_20x'
  const shouldShowUpsell = shouldProcessMockLimits() || isAgenCAISubscriber()
  const canSeeRateLimitOptionsUpsell = shouldShowUpsell && !isMax20x
  const [hasOpenedInteractiveMenu, setHasOpenedInteractiveMenu] =
    useState(false)
  const agencAiLimits = useAgenCAiLimits()
  const isCurrentlyRateLimited =
    agencAiLimits.status === 'rejected' &&
    agencAiLimits.resetsAt !== undefined &&
    !agencAiLimits.isUsingOverage
  const shouldAutoOpenRateLimitOptionsMenu =
    canSeeRateLimitOptionsUpsell &&
    !hasOpenedInteractiveMenu &&
    isCurrentlyRateLimited &&
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
