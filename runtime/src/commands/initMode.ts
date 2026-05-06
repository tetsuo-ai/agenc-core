import { feature } from 'bun:bundle'
import { isEnvTruthy } from '../../../utils/envUtils.js'

export function isNewInitEnabled(): boolean {
  if (feature('NEW_INIT')) {
    return (
      process.env.USER_TYPE === 'ant' ||
      isEnvTruthy(process.env.AGENC_NEW_INIT)
    )
  }

  return false
}
