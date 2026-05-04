import { isEnvTruthy } from '../upstream/utils/envUtils.js'

export function isUltrareviewEnabled(): boolean {
  return isEnvTruthy(process.env.AGENC_ULTRAREVIEW)
}
