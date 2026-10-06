import { isEnvTruthy } from './envUtils.js'
import { tokenizeCliOptionRegion } from '../bin/cli-option-region.js'

/**
 * Check if --agent-teams flag is provided via CLI.
 * Checks process.argv directly to avoid import cycles with bootstrap/state.
 */
function isAgentTeamsFlagSet(): boolean {
  return tokenizeCliOptionRegion(process.argv.slice(2)).optionArgs.includes(
    '--agent-teams',
  )
}

/**
 * Centralized runtime check for agent teams/teammate features.
 * This is the single gate that should be checked everywhere teammates
 * are referenced (prompts, code, tools isEnabled, UI, etc.).
 *
 * Teams are opt-in: the AGENC_EXPERIMENTAL_AGENT_TEAMS env var or the
 * --agent-teams flag turns them on. Nothing else does.
 */
export function isAgentSwarmsEnabled(): boolean {
  return (
    isEnvTruthy(process.env.AGENC_EXPERIMENTAL_AGENT_TEAMS) ||
    isAgentTeamsFlagSet()
  )
}
