// @ts-nocheck
// Moved-source note: imported by moved purge roots until the owning subsystem is absorbed.
import { BROWSER_TOOLS } from '@ant/agenc-for-chrome-mcp'
import { BASE_CHROME_PROMPT } from '../../utils/agencInChrome/prompt.js'
import { shouldAutoEnableAgenCInChrome } from '../../utils/agencInChrome/setup.js'
import { registerBundledSkill } from '../bundledSkills.js'

const AGENC_IN_CHROME_MCP_TOOLS = BROWSER_TOOLS.map(
  tool => `mcp__agenc-in-chrome__${tool.name}`,
)

const SKILL_ACTIVATION_MESSAGE = `
Now that this skill is invoked, you have access to Chrome browser automation tools. You can now use the mcp__agenc-in-chrome__* tools to interact with web pages.

IMPORTANT: Start by calling mcp__agenc-in-chrome__tabs_context_mcp to get information about the user's current browser tabs.
`

export function registerAgenCInChromeSkill(): void {
  registerBundledSkill({
    name: 'agenc-in-chrome',
    description:
      'Automates your Chrome browser to interact with web pages - clicking elements, filling forms, capturing screenshots, reading console logs, and navigating sites. Opens pages in new tabs within your existing Chrome session. Requires site-level permissions before executing (configured in the extension).',
    whenToUse:
      'When the user wants to interact with web pages, automate browser tasks, capture screenshots, read console logs, or perform any browser-based actions. Always invoke BEFORE attempting to use any mcp__agenc-in-chrome__* tools.',
    allowedTools: AGENC_IN_CHROME_MCP_TOOLS,
    userInvocable: true,
    isEnabled: () => shouldAutoEnableAgenCInChrome(),
    async getPromptForCommand(args) {
      let prompt = `${BASE_CHROME_PROMPT}\n${SKILL_ACTIVATION_MESSAGE}`
      if (args) {
        prompt += `\n## Task\n\n${args}`
      }
      return [{ type: 'text', text: prompt }]
    },
  })
}
