// Stable no-op gates for internal subscription and rate-limit simulations.

type SubscriptionType = string

export function shouldProcessMockLimits(): boolean {
  return false
}
export function getMockSubscriptionType(): SubscriptionType | null {
  return null
}

export function shouldUseMockSubscription(): boolean {
  return false
}
