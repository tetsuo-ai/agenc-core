import type { Command } from '../../../../commands.js'
import { isPolicyAllowed } from '../../services/policyLimits/index.js'
import { isAgenCAISubscriber } from '../../utils/auth.js'

export default {
  type: 'local-jsx',
  name: 'remote-env',
  description: 'Configure the default remote environment for teleport sessions',
  isEnabled: () =>
    isAgenCAISubscriber() && isPolicyAllowed('allow_remote_sessions'),
  get isHidden() {
    return !isAgenCAISubscriber() || !isPolicyAllowed('allow_remote_sessions')
  },
  load: () => import('./remote-env.js'),
} satisfies Command
