import type { ReactNode } from 'react'
import React from 'react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const originalDisableExtraUsageCommand =
  process.env.DISABLE_EXTRA_USAGE_COMMAND

const harness = vi.hoisted(() => ({
  hasBillingAccess: false,
  isAgenCAISubscriber: vi.fn(() => true),
  isNonInteractive: false,
  overageAllowed: true,
  rateLimitTier: null as string | null,
  subscriptionType: 'pro' as string | null,
}))

vi.mock('../../../src/bootstrap/state.js', async importOriginal => {
  const actual =
    await importOriginal<typeof import('../../../src/bootstrap/state.js')>()

  return {
    ...actual,
    getIsNonInteractiveSession: () => harness.isNonInteractive,
  }
})

vi.mock('../../../src/utils/auth.js', () => ({
  getRateLimitTier: () => harness.rateLimitTier,
  getSubscriptionType: () => harness.subscriptionType,
  isAgenCAISubscriber: harness.isAgenCAISubscriber,
  isOverageProvisioningAllowed: () => harness.overageAllowed,
}))

vi.mock('../../../src/utils/billing.js', () => ({
  hasAgenCAiBillingAccess: () => harness.hasBillingAccess,
}))

vi.mock('../../../src/tui/components/MessageResponse.js', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')

  return {
    MessageResponse: ({ children }: { readonly children: ReactNode }) =>
      ReactActual.createElement(ReactActual.Fragment, null, children),
  }
})

import {
  getUpsellMessage,
  RateLimitMessage,
} from '../../../src/tui/components/dialogs/RateLimitMessage.js'
import { renderToString } from '../../../src/utils/staticRender.js'

function restoreEnv(): void {
  if (originalDisableExtraUsageCommand === undefined) {
    delete process.env.DISABLE_EXTRA_USAGE_COMMAND
    return
  }

  process.env.DISABLE_EXTRA_USAGE_COMMAND =
    originalDisableExtraUsageCommand
}

async function renderRateLimitMessage(
  props: Partial<React.ComponentProps<typeof RateLimitMessage>> = {},
): Promise<string> {
  return renderToString(
    <RateLimitMessage text="Rate limit reached" {...props} />,
    { columns: 100 },
  )
}

describe('RateLimitMessage coverage swarm row 214', () => {
  beforeEach(() => {
    restoreEnv()
    harness.hasBillingAccess = false
    harness.isAgenCAISubscriber.mockReset()
    harness.isAgenCAISubscriber.mockReturnValue(true)
    harness.isNonInteractive = false
    harness.overageAllowed = true
    harness.rateLimitTier = null
    harness.subscriptionType = 'pro'
  })

  afterEach(() => {
    restoreEnv()
  })

  test('returns combined upgrade and extra-usage copy for non-team accounts with extra usage enabled', () => {
    expect(
      getUpsellMessage({
        hasBillingAccess: false,
        isExtraUsageCommandEnabled: true,
        isMax20x: false,
        isTeamOrEnterprise: false,
        shouldAutoOpenRateLimitOptionsMenu: false,
        shouldShowUpsell: true,
      }),
    ).toContain('/upgrade or /extra-usage')
  })

  test('does not show subscriber upsells for a non-subscriber', async () => {
    harness.isAgenCAISubscriber.mockReturnValue(false)

    const output = await renderRateLimitMessage()

    expect(output).toContain('Rate limit reached')
    expect(output).not.toContain('/upgrade')
    expect(output).not.toContain('/extra-usage')
    expect(harness.isAgenCAISubscriber).toHaveBeenCalledTimes(1)
  })

  test('hides extra-usage guidance when the command is disabled or the session is non-interactive', async () => {
    process.env.DISABLE_EXTRA_USAGE_COMMAND = '1'

    const disabledByEnvOutput = await renderRateLimitMessage()

    expect(disabledByEnvOutput).toContain(
      '/upgrade to increase your usage limit.',
    )
    expect(disabledByEnvOutput).not.toContain('/extra-usage')

    restoreEnv()
    harness.isNonInteractive = true

    const nonInteractiveOutput = await renderRateLimitMessage()

    expect(nonInteractiveOutput).toContain(
      '/upgrade to increase your usage limit.',
    )
    expect(nonInteractiveOutput).not.toContain('/extra-usage')
  })

})
