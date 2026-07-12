#!/usr/bin/env node
/**
 * Fake ACP agent for XaiAcpClient tests. Speaks newline-delimited JSON-RPC
 * 2.0 on stdio like `grok agent stdio`.
 *
 * Env switches:
 *   FAKE_ACP_REQUEST_PERMISSION=1  ask session/request_permission during
 *                                  prompt and echo the decision in a chunk
 *   FAKE_ACP_FAIL_AUTH=1           reject authenticate with -32000
 *   FAKE_ACP_STALL_PROMPT=1        never answer session/prompt
 */

import { createInterface } from 'node:readline'

let nextOutboundId = 1000
const pendingOutbound = new Map()

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

function respond(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function respondError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function notifyChunk(sessionId, text) {
  send({
    jsonrpc: '2.0',
    method: 'session/update',
    params: {
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      },
    },
  })
}

function requestFromAgent(method, params) {
  const id = nextOutboundId++
  return new Promise(resolve => {
    pendingOutbound.set(id, resolve)
    send({ jsonrpc: '2.0', id, method, params })
  })
}

const sessions = new Set()
let currentModelId = 'grok-build'

const reader = createInterface({ input: process.stdin })
reader.on('line', line => {
  const trimmed = line.trim()
  if (!trimmed) return
  let message
  try {
    message = JSON.parse(trimmed)
  } catch {
    return
  }

  // Response to an agent-initiated request (e.g. request_permission).
  if (message.method === undefined && pendingOutbound.has(message.id)) {
    pendingOutbound.get(message.id)(message.result)
    pendingOutbound.delete(message.id)
    return
  }

  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: 1,
        authMethods: [
          { id: 'xai.api_key', name: 'xAI API key' },
          { id: 'cached_token', name: 'Cached Grok CLI login' },
        ],
        agentCapabilities: {},
      })
      return
    case 'authenticate':
      if (process.env.FAKE_ACP_FAIL_AUTH === '1') {
        respondError(id, -32000, 'authentication failed: no cached login')
        return
      }
      respond(id, {})
      return
    case 'session/new': {
      const sessionId = `mock-session-${sessions.size + 1}`
      sessions.add(sessionId)
      respond(id, {
        sessionId,
        models: {
          currentModelId,
          availableModels: [
            { modelId: 'grok-build', name: 'Grok Build' },
            { modelId: 'grok-composer-2.5-fast', name: 'Composer 2.5 Fast' },
          ],
        },
      })
      return
    }
    case 'session/set_model':
      currentModelId = params.modelId
      respond(id, {})
      return
    case 'session/prompt': {
      if (process.env.FAKE_ACP_STALL_PROMPT === '1') {
        return
      }
      const sessionId = params.sessionId
      const run = async () => {
        notifyChunk(sessionId, `[${currentModelId}] `)
        notifyChunk(sessionId, 'Hello ')
        if (process.env.FAKE_ACP_REQUEST_PERMISSION === '1') {
          const outcome = await requestFromAgent('session/request_permission', {
            sessionId,
            toolCall: { title: 'Write file' },
            options: [
              { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
              { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
            ],
          })
          notifyChunk(
            sessionId,
            `perm=${outcome?.outcome?.outcome}:${outcome?.outcome?.optionId ?? ''} `,
          )
        }
        notifyChunk(sessionId, 'world')
        respond(id, { stopReason: 'end_turn' })
      }
      void run()
      return
    }
    case 'session/cancel':
      return
    default:
      if (id !== undefined) {
        respondError(id, -32601, `unknown method: ${method}`)
      }
  }
})
