import {
  getAnthropicApiKey,
  getAuthTokenSource,
  getOauthAccountInfo,
  getSubscriptionType,
  isAgenCAISubscriber,
} from './auth.js'
import { isEnvTruthy } from './envUtils.js'
import { resolveSecureStorageHome } from './secureStorage/home.js'

function credentialHome() {
  return resolveSecureStorageHome()
}

export function hasConsoleBillingAccess(): boolean {
  // Check if cost reporting is disabled via environment variable
  if (isEnvTruthy(process.env.DISABLE_COST_WARNINGS)) {
    return false
  }

  const isSubscriber = isAgenCAISubscriber(credentialHome())

  // This might be wrong if user is signed into Max but also using an API key, but
  // we already show a warning on launch in that case
  if (isSubscriber) return false

  // Check if user has any form of authentication
  const authSource = getAuthTokenSource(credentialHome())
  const hasApiKey = getAnthropicApiKey() !== null

  // If user has no authentication at all (logged out), don't show costs
  if (!authSource.hasToken && !hasApiKey) {
    return false
  }

  const account = getOauthAccountInfo(credentialHome())
  const orgRole = account?.organizationRole
  const workspaceRole = account?.workspaceRole

  if (!orgRole || !workspaceRole) {
    return false // hide cost for grandfathered users who have not re-authed since we've added roles
  }

  // Users have billing access if they are admins or billing roles at either workspace or organization level
  return (
    ['admin', 'billing'].includes(orgRole) ||
    ['workspace_admin', 'workspace_billing'].includes(workspaceRole)
  )
}

export function hasAgenCAiBillingAccess(): boolean {
  if (!isAgenCAISubscriber(credentialHome())) {
    return false
  }

  const subscriptionType = getSubscriptionType(credentialHome())

  // Consumer plans (Max/Pro) - individual users always have billing access
  if (subscriptionType === 'max' || subscriptionType === 'pro') {
    return true
  }

  // Team/Enterprise - check for admin or billing roles
  const orgRole = getOauthAccountInfo(credentialHome())?.organizationRole

  return (
    !!orgRole &&
    ['admin', 'billing', 'owner', 'primary_owner'].includes(orgRole)
  )
}
