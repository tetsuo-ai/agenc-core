import React from 'react'
import { describe, expect, test, vi, beforeEach } from 'vitest'

import { renderToString } from '../../../agenc/upstream/utils/staticRender.js'
import { CostThresholdDialog } from './CostThresholdDialog.js'
import { getUpsellMessage, RateLimitMessage } from './RateLimitMessage.js'

const providerMock = vi.hoisted(() => ({
  provider: 'firstParty',
}))

const rateLimitMock = vi.hoisted(() => ({
  subscriptionType: 'pro',
  rateLimitTier: null as string | null,
  isSubscriber: true,
  hasBillingAccess: false,
  shouldProcessMockLimits: false,
  extraUsageEnabled: false,
  limits: {
    status: 'accepted',
    resetsAt: undefined as number | undefined,
    isUsingOverage: false,
  },
}))

vi.mock('bun:bundle', () => ({
  feature: () => false,
}))

vi.mock('../CustomSelect/select.js', async () => {
  const { Box, Text } = await import('../../ink.js')
  return {
    Select: ({ options }: { options: Array<{ label: string }> }) => (
      <Box flexDirection="column">
        {options.map(option => (
          <Text key={option.label}>{option.label}</Text>
        ))}
      </Box>
    ),
  }
})

vi.mock('../design-system/Dialog.js', async () => {
  const { Box, Text } = await import('../../ink.js')
  return {
    Dialog: ({
    title,
    children,
  }: {
    title: string
    children: React.ReactNode
  }) => (
    <Box flexDirection="column">
      <Text>{title}</Text>
      {children}
    </Box>
  ),
  }
})

vi.mock('../../../agenc/upstream/utils/model/providers.js', () => ({
  getAPIProvider: () => providerMock.provider,
}))

vi.mock('../../../agenc/upstream/commands/extra-usage/index.js', () => ({
  extraUsage: {
    isEnabled: () => rateLimitMock.extraUsageEnabled,
  },
}))

vi.mock('../../../agenc/upstream/services/rateLimitMocking.js', () => ({
  shouldProcessMockLimits: () => rateLimitMock.shouldProcessMockLimits,
}))

vi.mock('../../rate-limits/agenc-ai-limits.js', () => ({
  useAgenCAiLimits: () => rateLimitMock.limits,
}))

vi.mock('../../../agenc/upstream/utils/auth.js', () => ({
  getSubscriptionType: () => rateLimitMock.subscriptionType,
  getRateLimitTier: () => rateLimitMock.rateLimitTier,
  isAgenCAISubscriber: () => rateLimitMock.isSubscriber,
}))

vi.mock('../../../agenc/upstream/utils/billing.js', () => ({
  hasAgenCAiBillingAccess: () => rateLimitMock.hasBillingAccess,
}))

vi.mock('../MessageResponse.js', () => ({
  MessageResponse: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

describe('cost and limit dialogs', () => {
  beforeEach(() => {
    providerMock.provider = 'firstParty'
    rateLimitMock.subscriptionType = 'pro'
    rateLimitMock.rateLimitTier = null
    rateLimitMock.isSubscriber = true
    rateLimitMock.hasBillingAccess = false
    rateLimitMock.shouldProcessMockLimits = false
    rateLimitMock.extraUsageEnabled = false
    rateLimitMock.limits = {
      status: 'accepted',
      resetsAt: undefined,
      isUsingOverage: false,
    }
  })

  test('renders the cost threshold dialog with provider label and AgenC docs link', async () => {
    providerMock.provider = 'bedrock'

    const output = await renderToString(
      <CostThresholdDialog onDone={() => {}} />,
      80,
    )

    expect(output).toContain("You've spent $5 on the AWS Bedrock this session.")
    expect(output).toContain('https://agenc.tech/docs/costs')
    expect(output).toContain('Got it, thanks!')
  })

  test('selects the expected upsell copy for account and billing states', () => {
    expect(getUpsellMessage({
      shouldShowUpsell: false,
      isMax20x: false,
      isExtraUsageCommandEnabled: false,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: false,
      hasBillingAccess: false,
    })).toBeNull()

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: true,
      isExtraUsageCommandEnabled: true,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: false,
      hasBillingAccess: false,
    })).toContain('/extra-usage')

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: true,
      isExtraUsageCommandEnabled: false,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: false,
      hasBillingAccess: false,
    })).toContain('/login')

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: false,
      isExtraUsageCommandEnabled: false,
      shouldAutoOpenRateLimitOptionsMenu: true,
      isTeamOrEnterprise: false,
      hasBillingAccess: false,
    })).toBe('Opening your options…')

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: false,
      isExtraUsageCommandEnabled: false,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: false,
      hasBillingAccess: false,
    })).toContain('/upgrade')

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: false,
      isExtraUsageCommandEnabled: false,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: true,
      hasBillingAccess: true,
    })).toBeNull()

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: false,
      isExtraUsageCommandEnabled: true,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: true,
      hasBillingAccess: true,
    })).toContain('finish what you’re working on')

    expect(getUpsellMessage({
      shouldShowUpsell: true,
      isMax20x: false,
      isExtraUsageCommandEnabled: true,
      shouldAutoOpenRateLimitOptionsMenu: false,
      isTeamOrEnterprise: true,
      hasBillingAccess: false,
    })).toContain('request more usage from your admin')
  })

  test('renders rate limit text with upgrade upsell when available', async () => {
    rateLimitMock.isSubscriber = true
    rateLimitMock.extraUsageEnabled = false

    const output = await renderToString(
      <RateLimitMessage text="Rate limit reached" />,
      80,
    )

    expect(output).toContain('Rate limit reached')
    expect(output).toContain('/upgrade to increase your usage limit.')
  })

  test('opens the interactive rate-limit options once when currently limited', async () => {
    rateLimitMock.isSubscriber = true
    rateLimitMock.limits = {
      status: 'rejected',
      resetsAt: Date.now() + 60_000,
      isUsingOverage: false,
    }
    const onOpenRateLimitOptions = vi.fn()

    const output = await renderToString(
      <RateLimitMessage
        text="Rate limit reached"
        onOpenRateLimitOptions={onOpenRateLimitOptions}
      />,
      80,
    )

    expect(output).toContain('Rate limit reached')
    expect(onOpenRateLimitOptions).toHaveBeenCalledTimes(1)
  })
})
