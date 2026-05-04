import { getFeatureValue_CACHED_MAY_BE_STALE } from '../upstream/services/analytics/growthbook.js'

export function isUltrareviewEnabled(): boolean {
  const config = getFeatureValue_CACHED_MAY_BE_STALE<Record<
    string,
    unknown
  > | null>('tengu_review_bughunter_config', null)
  return config?.enabled === true
}
