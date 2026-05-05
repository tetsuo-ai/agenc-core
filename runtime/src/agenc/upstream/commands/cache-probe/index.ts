import type { Command } from '../../../../commands.js'
import { isEnvTruthy } from '../../utils/envUtils.js'

const cacheProbe: Command = {
  type: 'local',
  name: 'cache-probe',
  description:
    'Send identical requests to test prompt caching (results in debug log)',
  argumentHint: '[model] [--no-key]',
  isEnabled: () =>
    isEnvTruthy(process.env.AGENC_USE_OPENAI) ||
    isEnvTruthy(process.env.AGENC_USE_GITHUB),
  supportsNonInteractive: false,
  load: () => import('./cache-probe.js'),
}

export default cacheProbe
