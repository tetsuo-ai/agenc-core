import React from 'react'
import Module from 'node:module'
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest'

const state = vi.hoisted(() => {
  const sentinel = Symbol.for('react.memo_cache_sentinel')
  const cache: unknown[] = []
  const features = new Set<string>()
  const stub = (name: string) =>
    Object.assign(function StubComponent() {
      return null
    }, { displayName: name })

  return {
    sentinel,
    cache,
    features,
    renderers: {
      InterruptedByUser: stub('InterruptedByUser'),
      MessageResponse: stub('MessageResponse'),
      UserAgentNotificationMessage: stub('UserAgentNotificationMessage'),
      UserBashInputMessage: stub('UserBashInputMessage'),
      UserBashOutputMessage: stub('UserBashOutputMessage'),
      UserChannelMessage: stub('UserChannelMessage'),
      UserCommandMessage: stub('UserCommandMessage'),
      UserLocalCommandOutputMessage: stub('UserLocalCommandOutputMessage'),
      UserMemoryInputMessage: stub('UserMemoryInputMessage'),
      UserPlanMessage: stub('UserPlanMessage'),
      UserPromptMessage: stub('UserPromptMessage'),
      UserResourceUpdateMessage: stub('UserResourceUpdateMessage'),
      UserTeammateMessage: stub('UserTeammateMessage'),
    },
    dynamicRenderers: {
      UserCrossSessionMessage: stub('UserCrossSessionMessage'),
      UserForkBoilerplateMessage: stub('UserForkBoilerplateMessage'),
      UserGitHubWebhookMessage: stub('UserGitHubWebhookMessage'),
    },
  }
})

vi.mock('react-compiler-runtime', () => ({
  c: (size: number) => {
    if (state.cache.length !== size) {
      state.cache.length = 0
      for (let index = 0; index < size; index += 1) {
        state.cache.push(state.sentinel)
      }
    }
    return state.cache
  },
}))

vi.mock('bun:bundle', () => ({
  feature: (name: string) => state.features.has(name),
}))

vi.mock('../message-renderers/UserTextMessage.renderers.js', () => ({
  ...state.renderers,
}))

import { NO_CONTENT_MESSAGE } from '../../constants/messages.js'
import {
  COMMAND_MESSAGE_TAG,
  LOCAL_COMMAND_CAVEAT_TAG,
  TASK_NOTIFICATION_TAG,
  TEAMMATE_MESSAGE_TAG,
  TICK_TAG,
} from '../../constants/xml.js'
import { INTERRUPT_MESSAGE } from '../../utils/messages.js'
import { UserTextMessage } from '../message-renderers/UserTextMessage.js'

type UserTextMessageProps = Parameters<typeof UserTextMessage>[0]
type ReactElementWithProps = React.ReactElement<Record<string, unknown>>
type ModuleWithLoad = typeof Module & {
  _load: (
    request: string,
    parent: unknown,
    isMain: boolean,
  ) => unknown
}

const moduleWithLoad = Module as ModuleWithLoad
const originalModuleLoad = moduleWithLoad._load
const originalUserType = process.env.USER_TYPE

function resetUserType(): void {
  if (originalUserType === undefined) {
    delete process.env.USER_TYPE
  } else {
    process.env.USER_TYPE = originalUserType
  }
}

function makeProps(
  text: string,
  overrides: Partial<Omit<UserTextMessageProps, 'param'>> = {},
): UserTextMessageProps {
  return {
    addMargin: false,
    param: { type: 'text', text },
    verbose: false,
    ...overrides,
  }
}

function asElement(node: React.ReactNode): ReactElementWithProps {
  expect(React.isValidElement(node)).toBe(true)
  return node as ReactElementWithProps
}

function expectCachedElement(
  props: UserTextMessageProps,
  expectedType: React.ElementType,
): ReactElementWithProps {
  const first = asElement(UserTextMessage(props))
  const second = asElement(UserTextMessage(props))

  expect(second).toBe(first)
  expect(first.type).toBe(expectedType)

  return first
}

beforeEach(() => {
  state.cache.length = 0
  state.features.clear()
  resetUserType()

  moduleWithLoad._load = function loadDynamicRenderer(
    request: string,
    parent: unknown,
    isMain: boolean,
  ) {
    switch (request) {
      case './UserCrossSessionMessage.js':
        return {
          UserCrossSessionMessage:
            state.dynamicRenderers.UserCrossSessionMessage,
        }
      case './UserForkBoilerplateMessage.js':
        return {
          UserForkBoilerplateMessage:
            state.dynamicRenderers.UserForkBoilerplateMessage,
        }
      case './UserGitHubWebhookMessage.js':
        return {
          UserGitHubWebhookMessage:
            state.dynamicRenderers.UserGitHubWebhookMessage,
        }
      default:
        return originalModuleLoad.call(this, request, parent, isMain)
    }
  }
})

afterAll(() => {
  moduleWithLoad._load = originalModuleLoad
  resetUserType()
})

describe('UserTextMessage swarm 018 coverage', () => {
  test('returns null for hidden synthetic messages', () => {
    expect(UserTextMessage(makeProps(`  ${NO_CONTENT_MESSAGE}  `))).toBeNull()
    expect(
      UserTextMessage(makeProps(`<${TICK_TAG}>heartbeat</${TICK_TAG}>`)),
    ).toBeNull()
    expect(
      UserTextMessage(
        makeProps(
          `<${LOCAL_COMMAND_CAVEAT_TAG}>hidden</${LOCAL_COMMAND_CAVEAT_TAG}>`,
        ),
      ),
    ).toBeNull()
  })

  test('reuses cached elements for standard user-message routes', () => {
    const plan = expectCachedElement(
      makeProps('ignored once plan content exists', {
        addMargin: true,
        planContent: '1. inspect route\n2. assert cache',
      }),
      state.renderers.UserPlanMessage,
    )
    expect(plan.props.addMargin).toBe(true)
    expect(plan.props.planContent).toContain('assert cache')

    const bashOutput = expectCachedElement(
      makeProps('<bash-stderr>stderr branch</bash-stderr>', { verbose: true }),
      state.renderers.UserBashOutputMessage,
    )
    expect(bashOutput.props.content).toContain('stderr branch')
    expect(bashOutput.props.verbose).toBe(true)

    const localOutput = expectCachedElement(
      makeProps(
        '<local-command-stderr>local stderr</local-command-stderr>',
      ),
      state.renderers.UserLocalCommandOutputMessage,
    )
    expect(localOutput.props.content).toContain('local stderr')

    const interrupted = expectCachedElement(
      makeProps(INTERRUPT_MESSAGE),
      state.renderers.MessageResponse,
    )
    const interruptedChild = asElement(interrupted.props.children)
    expect(interrupted.props.height).toBe(1)
    expect(interruptedChild.type).toBe(state.renderers.InterruptedByUser)

    const bashInput = expectCachedElement(
      makeProps('<bash-input>npm test</bash-input>'),
      state.renderers.UserBashInputMessage,
    )
    expect(bashInput.props.param).toMatchObject({
      text: '<bash-input>npm test</bash-input>',
    })

    const command = expectCachedElement(
      makeProps(`<${COMMAND_MESSAGE_TAG}>/status</${COMMAND_MESSAGE_TAG}>`),
      state.renderers.UserCommandMessage,
    )
    expect(command.props.param).toMatchObject({
      text: `<${COMMAND_MESSAGE_TAG}>/status</${COMMAND_MESSAGE_TAG}>`,
    })

    const memory = expectCachedElement(
      makeProps('<user-memory-input>remember this</user-memory-input>'),
      state.renderers.UserMemoryInputMessage,
    )
    expect(memory.props.text).toContain('remember this')

    process.env.USER_TYPE = 'ant'
    const teammate = expectCachedElement(
      makeProps(
        `<${TEAMMATE_MESSAGE_TAG} teammate_id="qa">hello</${TEAMMATE_MESSAGE_TAG}>`,
        { isTranscriptMode: true },
      ),
      state.renderers.UserTeammateMessage,
    )
    expect(teammate.props.isTranscriptMode).toBe(true)

    const task = expectCachedElement(
      makeProps(`<${TASK_NOTIFICATION_TAG}>done</${TASK_NOTIFICATION_TAG}>`),
      state.renderers.UserAgentNotificationMessage,
    )
    expect(task.props.param).toMatchObject({
      text: `<${TASK_NOTIFICATION_TAG}>done</${TASK_NOTIFICATION_TAG}>`,
    })

    const resource = expectCachedElement(
      makeProps('<mcp-resource-update>changed</mcp-resource-update>'),
      state.renderers.UserResourceUpdateMessage,
    )
    expect(resource.props.param).toMatchObject({
      text: '<mcp-resource-update>changed</mcp-resource-update>',
    })

    const prompt = expectCachedElement(
      makeProps('ordinary prompt', {
        addMargin: true,
        isTranscriptMode: true,
        timestamp: '12:34',
      }),
      state.renderers.UserPromptMessage,
    )
    expect(prompt.props).toMatchObject({
      addMargin: true,
      isTranscriptMode: true,
      timestamp: '12:34',
    })
  })

  test('routes enabled dynamic feature messages and reuses their cached modules', () => {
    state.features.add('KAIROS_GITHUB_WEBHOOKS')
    const webhook = expectCachedElement(
      makeProps(
        '<github-webhook-activity><event>push</event></github-webhook-activity>',
        { addMargin: true },
      ),
      state.dynamicRenderers.UserGitHubWebhookMessage,
    )
    expect(webhook.props.addMargin).toBe(true)

    state.cache.length = 0
    state.features.clear()
    state.features.add('FORK_SUBAGENT')
    const fork = expectCachedElement(
      makeProps('<fork-boilerplate>Your directive: test</fork-boilerplate>'),
      state.dynamicRenderers.UserForkBoilerplateMessage,
    )
    expect(fork.props.param).toMatchObject({
      text: '<fork-boilerplate>Your directive: test</fork-boilerplate>',
    })

    state.cache.length = 0
    state.features.clear()
    state.features.add('UDS_INBOX')
    const crossSession = expectCachedElement(
      makeProps('<cross-session-message from="peer">hello</cross-session-message>'),
      state.dynamicRenderers.UserCrossSessionMessage,
    )
    expect(crossSession.props.param).toMatchObject({
      text: '<cross-session-message from="peer">hello</cross-session-message>',
    })
  })

  test('falls through enabled feature gates without matching tags and routes channel flags', () => {
    state.features.add('KAIROS_GITHUB_WEBHOOKS')
    state.features.add('FORK_SUBAGENT')
    state.features.add('UDS_INBOX')
    state.features.add('KAIROS')

    const prompt = expectCachedElement(
      makeProps('feature flags enabled without special tags'),
      state.renderers.UserPromptMessage,
    )
    expect(prompt.props.param).toMatchObject({
      text: 'feature flags enabled without special tags',
    })

    state.cache.length = 0
    const kairosChannel = expectCachedElement(
      makeProps('<channel source="inbox">body</channel>'),
      state.renderers.UserChannelMessage,
    )
    expect(kairosChannel.props.param).toMatchObject({
      text: '<channel source="inbox">body</channel>',
    })

    state.cache.length = 0
    state.features.clear()
    state.features.add('KAIROS_CHANNELS')
    const channelsFlag = expectCachedElement(
      makeProps('<channel source="updates">body</channel>'),
      state.renderers.UserChannelMessage,
    )
    expect(channelsFlag.props.param).toMatchObject({
      text: '<channel source="updates">body</channel>',
    })
  })
})
