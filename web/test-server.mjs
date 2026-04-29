/**
 * Minimal test server for the WebChat UI.
 *
 * Starts a Gateway with WebChatChannel behavior wired in so the frontend
 * can connect and exercise every major view during local and CI e2e tests.
 *
 * Usage:
 *   node web/test-server.mjs
 *
 * Then in another terminal:
 *   cd web && npm run dev
 *
 * Open http://localhost:5173 — the connection indicator should go green.
 */

import { createRequire } from 'module';
import { createRunStateController } from './test-server-run-state.mjs';
const require = createRequire(import.meta.url);
const ws = require('ws');
const WebSocketServer = ws.WebSocketServer || ws.Server;

const PORT = Number(process.env.WEBCHAT_WS_PORT ?? process.env.WS_PORT ?? 3100);
const HOST = '127.0.0.1';
const CHAT_SESSION_ID = 'session_local_1';

const PORTFACING_SKILLS = [
  { name: 'jupiter-dex', description: 'Jupiter DEX swap integration', enabled: true },
  { name: 'web-search', description: 'Search the web for information', enabled: true },
  { name: 'code-exec', description: 'Execute code in sandbox', enabled: false },
];

const TEST_TASKS = [
  { id: 'task_abc123', status: 'Open', reward: '1000000', creator: 'Abc1234...', worker: null },
  { id: 'task_def456', status: 'InProgress', reward: '5000000', creator: 'Xyz9876...', worker: 'Worker1...' },
];

const TEST_AGENTS = [
  {
    pda: 'agent_mock_mainnet_001',
    agentId: 'agent-main-001',
    authority: 'Auth11111111111111111111111111111111111111',
    capabilities: ['chat', 'webchat', 'voice'],
    status: 'Active',
    reputation: 98,
    tasksCompleted: 12,
    stake: '12.5',
    endpoint: 'wss://localhost:3100',
    metadataUri: 'https://example.com/metadata/main.json',
    registeredAt: 1_700_000_000,
    lastActive: 1_700_000_000,
    totalEarned: '45',
    activeTasks: 1,
  },
];

const TEST_CONTINUITY_SESSIONS = [
  {
    sessionId: CHAT_SESSION_ID,
    label: 'Local Coding Session',
    preview: 'Investigate unified session surface parity',
    messageCount: 14,
    createdAt: Date.now() - 60 * 60 * 1000,
    updatedAt: Date.now() - 2 * 60 * 1000,
    lastActiveAt: Date.now() - 2 * 60 * 1000,
    connected: true,
    resumabilityState: 'active',
    shellProfile: 'coding',
    workflowStage: 'implement',
    workspaceRoot: '/tmp/agenc-demo',
    repoRoot: '/tmp/agenc-demo',
    branch: 'feature/demo',
    head: 'abc1234',
    childSessionCount: 1,
    worktreeCount: 1,
    pendingApprovalCount: 0,
  },
];

const TEST_COCKPIT = {
  session: {
    sessionId: CHAT_SESSION_ID,
    shellProfile: 'coding',
    workflowStage: 'implement',
    resumabilityState: 'active',
    preview: 'Investigate unified session surface parity',
    objective: 'Close remaining shell/console/web drift.',
    messageCount: 14,
    lastActiveAt: Date.now() - 2 * 60 * 1000,
  },
  repo: {
    available: true,
    workspaceRoot: '/tmp/agenc-demo',
    repoRoot: '/tmp/agenc-demo',
    branch: 'feature/demo',
    head: 'abc1234',
    dirtyCounts: { staged: 1, unstaged: 2, untracked: 0, conflicted: 0 },
    changedFiles: ['runtime/src/gateway/daemon-command-registry.ts', 'web/src/hooks/useChat.ts'],
  },
  worktrees: {
    available: true,
    entries: [
      {
        path: '/tmp/agenc-demo',
        branch: 'feature/demo',
        head: 'abc1234',
        clean: false,
        ownedByRuntime: true,
        ownerRole: 'coding',
      },
    ],
  },
  review: {
    status: 'completed',
    source: 'local',
    startedAt: Date.now() - 10 * 60 * 1000,
    updatedAt: Date.now() - 5 * 60 * 1000,
    completedAt: Date.now() - 5 * 60 * 1000,
    summaryPreview: 'Review completed with one remaining parity gap.',
  },
  verification: {
    status: 'running',
    source: 'delegated',
    startedAt: Date.now() - 3 * 60 * 1000,
    updatedAt: Date.now() - 30 * 1000,
    verdict: 'unknown',
    summaryPreview: 'Verifier is still running web parity checks.',
  },
  approvals: {
    count: 1,
    entries: [
      {
        requestId: 'approval-demo-1',
        toolName: 'system.applyPatch',
        state: 'pending',
        preview: 'Apply the final cleanup patch',
      },
    ],
  },
  ownership: [
    {
      role: 'coding',
      state: 'running',
      childSessionId: 'child-demo-1',
      shellProfile: 'coding',
      worktreePath: '/tmp/agenc-demo',
    },
  ],
};

const TEST_COMMAND_CATALOG = [
  {
    name: 'session',
    description: 'Inspect the current shell session or continuity catalog',
    args: '[status|list|inspect|history|resume|fork]',
    global: true,
    aliases: [],
    category: 'session',
    clients: ['shell', 'console', 'web'],
    viewKind: 'session',
    available: true,
  },
  {
    name: 'review',
    description: 'Summarize repo state for review',
    args: '[--staged|--delegate|--mode security|--mode pr-comments]',
    global: true,
    aliases: [],
    category: 'coding',
    clients: ['shell', 'console', 'web'],
    viewKind: 'review',
    available: true,
  },
  {
    name: 'diff',
    description: 'Show change summary plus diff',
    args: '[--staged|--from <ref>|--to <ref>|--files <a,b>]',
    global: true,
    aliases: [],
    category: 'coding',
    clients: ['shell', 'console', 'web'],
    viewKind: 'diff',
    available: true,
  },
];

const TEST_HISTORY = [
  { content: 'Audit remaining drift', sender: 'user', timestamp: Date.now() - 10_000 },
  { content: 'Continuing with shell/console/web unification.', sender: 'agent', timestamp: Date.now() - 9_000 },
];

const DEFAULT_CONFIG = {
  llm: {
    provider: 'grok',
    apiKey: '****demo',
    model: 'grok-4-fast-reasoning',
    baseUrl: 'https://api.x.ai/v1',
  },
  voice: {
    enabled: true,
    mode: 'vad',
    voice: 'Ara',
    apiKey: '',
  },
  memory: {
    backend: 'memory',
  },
  connection: {
    rpcUrl: 'https://api.devnet.solana.com',
  },
  logging: {
    level: 'info',
  },
};

const OLLAMA_MODELS = ['llama3', 'qwen2.5'];
const runState = createRunStateController();

let nextToolCallId = 1;
let nextSandboxId = 1;

// Track clients
let clientCounter = 0;
const clients = new Map();

const wss = new WebSocketServer({ port: PORT, host: HOST });

console.log(`WebChat test server listening on ${HOST}:${PORT} (ws)`);
console.log('Run "cd web && npm run dev" and open http://localhost:5173\n');

wss.on('connection', (ws) => {
  const clientId = `client_${++clientCounter}`;
  clients.set(clientId, ws);
  console.log(`[+] ${clientId} connected`);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
      return;
    }

    const id = typeof msg.id === 'string' ? msg.id : undefined;
    const payload = msg.payload ?? {};

    console.log('%s %s', `[${clientId}] ${msg.type}`, payload.content ? `"${payload.content}"` : '');

    switch (msg.type) {
      case 'ping':
        ws.send(JSON.stringify({ type: 'pong', id }));
        break;

      case 'chat.message': {
        const content = payload.content ?? '';

        setTimeout(() => {
          ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: true } }));
          ws.send(JSON.stringify({ type: 'chat.session', payload: { sessionId: CHAT_SESSION_ID } }));

          if (content.toLowerCase().includes('tool')) {
            const toolCallId = `tool-${nextToolCallId++}`;
            setTimeout(() => {
              ws.send(JSON.stringify({
                type: 'tools.executing',
                payload: {
                  toolName: 'agenc.listTasks',
                  toolCallId,
                  args: { status: 'open' },
                },
              }));

              setTimeout(() => {
                ws.send(JSON.stringify({
                  type: 'tools.result',
                  payload: {
                    toolName: 'agenc.listTasks',
                    toolCallId,
                    result: JSON.stringify([{ id: 'task_1', status: 'Open' }]),
                    durationMs: 42,
                    isError: false,
                  },
                }));
              }, 400);
            }, 150);
          }

          setTimeout(() => {
            ws.send(JSON.stringify({ type: 'chat.typing', payload: { active: false } }));
            ws.send(JSON.stringify({
              type: 'chat.message',
              payload: {
                content: `You said: "${content}"`,
                sender: 'agent',
                timestamp: Date.now(),
              },
            }));
          }, 650);
        }, 50);
        break;
      }

      case 'chat.typing':
        // Acknowledged silently
        break;

      case 'chat.history':
        ws.send(JSON.stringify({ type: 'chat.history', payload: TEST_HISTORY, id }));
        break;

      case 'chat.session.list':
        ws.send(JSON.stringify({ type: 'chat.session.list', payload: TEST_CONTINUITY_SESSIONS, id }));
        break;

      case 'chat.session.inspect':
        ws.send(JSON.stringify({
          type: 'error',
          error: `Session "${payload.sessionId}" not found in test server`,
          id,
        }));
        break;

      case 'chat.session.fork':
        ws.send(JSON.stringify({
          type: 'error',
          error: `Session "${payload.sessionId}" not found in test server`,
          id,
        }));
        break;

      case 'chat.session.resume':
        ws.send(JSON.stringify({
          type: 'chat.session.resumed',
          payload: {
            sessionId: payload.sessionId ?? CHAT_SESSION_ID,
            messageCount: TEST_HISTORY.length,
            workspaceRoot: '/tmp/agenc-demo',
            shellProfile: 'coding',
          },
          id,
        }));
        break;

      case 'session.command.catalog.get':
        ws.send(JSON.stringify({
          type: 'session.command.catalog',
          payload: TEST_COMMAND_CATALOG,
          id,
        }));
        break;

      case 'watch.cockpit.get':
        ws.send(JSON.stringify({
          type: 'watch.cockpit',
          payload: TEST_COCKPIT,
          id,
        }));
        break;

      case 'session.command.execute': {
        const content = String(payload.content ?? '').trim();
        if (content.startsWith('/session list')) {
          ws.send(JSON.stringify({
            type: 'session.command.result',
            payload: {
              commandName: 'session',
              content: 'Listed sessions.',
              sessionId: CHAT_SESSION_ID,
              viewKind: 'session',
              data: {
                kind: 'session',
                subcommand: 'list',
                sessions: TEST_CONTINUITY_SESSIONS,
              },
            },
            id,
          }));
          break;
        }
        if (content.startsWith('/session history')) {
          ws.send(JSON.stringify({
            type: 'session.command.result',
            payload: {
              commandName: 'session',
              content: 'Loaded session history.',
              sessionId: CHAT_SESSION_ID,
              viewKind: 'session',
              data: {
                kind: 'session',
                subcommand: 'history',
                history: TEST_HISTORY,
              },
            },
            id,
          }));
          break;
        }
        if (content.startsWith('/session resume')) {
          ws.send(JSON.stringify({
            type: 'session.command.result',
            payload: {
              commandName: 'session',
              content: 'Resumed session.',
              sessionId: CHAT_SESSION_ID,
              viewKind: 'session',
              data: {
                kind: 'session',
                subcommand: 'resume',
                resumed: {
                  sessionId: CHAT_SESSION_ID,
                  messageCount: TEST_HISTORY.length,
                  workspaceRoot: '/tmp/agenc-demo',
                },
              },
            },
            id,
          }));
          break;
        }
        ws.send(JSON.stringify({
          type: 'session.command.result',
          payload: {
            commandName: content.startsWith('/') ? content.slice(1).split(/\s+/)[0] : 'command',
            content: `Handled ${content || 'command'}.`,
            sessionId: CHAT_SESSION_ID,
          },
          id,
        }));
        break;
      }

      case 'status.get':
        {
        const testRunDetail = runState.getDetail();
        ws.send(JSON.stringify({
          type: 'status.update',
          payload: {
            state: 'running',
            uptimeMs: Date.now() - startTime,
            channels: ['webchat'],
            activeSessions: clients.size,
            controlPlanePort: PORT,
            agentName: 'test-agent',
            backgroundRuns: {
              activeTotal: 1,
              queuedSignalsTotal: testRunDetail.pendingSignals,
              stateCounts: {
                pending: 0,
                running: testRunDetail.state === 'running' ? 1 : 0,
                working: testRunDetail.state === 'working' ? 1 : 0,
                blocked: testRunDetail.state === 'blocked' ? 1 : 0,
                paused: testRunDetail.state === 'paused' ? 1 : 0,
                completed: testRunDetail.state === 'completed' ? 1 : 0,
                failed: testRunDetail.state === 'failed' ? 1 : 0,
                cancelled: testRunDetail.state === 'cancelled' ? 1 : 0,
                suspended: testRunDetail.state === 'suspended' ? 1 : 0,
              },
              recentAlerts: [],
              metrics: {
                startedTotal: 1,
                completedTotal: 0,
                failedTotal: 0,
                blockedTotal: 0,
                recoveredTotal: 0,
                meanLatencyMs: 120,
                meanTimeToFirstAckMs: 300,
                meanTimeToFirstVerifiedUpdateMs: 2500,
                falseCompletionRate: 0,
                blockedWithoutNoticeRate: 0,
                meanStopLatencyMs: 900,
                recoverySuccessRate: 1,
                verifierAccuracyRate: 1,
              },
            },
          },
          id,
        }));
        break;
        }

      case 'runs.list':
        ws.send(JSON.stringify({
          type: 'runs.list',
          payload: [runState.summarize()],
          id,
        }));
        break;

      case 'run.inspect':
        ws.send(JSON.stringify({
          type: 'run.inspect',
          payload: runState.getDetail(),
          id,
        }));
        break;

      case 'run.control': {
        runState.applyControl(payload);

        ws.send(JSON.stringify({
          type: 'run.updated',
          payload: runState.getDetail(),
          id,
        }));
        break;
      }

      case 'skills.list':
        ws.send(JSON.stringify({
          type: 'skills.list',
          payload: PORTFACING_SKILLS,
          id,
        }));
        break;

      case 'skills.toggle':
        ws.send(JSON.stringify({ type: 'skills.list', payload: PORTFACING_SKILLS, id }));
        break;

      case 'tasks.list':
        ws.send(JSON.stringify({
          type: 'tasks.list',
          payload: TEST_TASKS,
          id,
        }));
        break;

      case 'tasks.create':
        ws.send(JSON.stringify({
          type: 'tasks.list',
          payload: [...TEST_TASKS, { id: 'task_new', status: 'Open', reward: '250000', creator: 'local-user', worker: null }],
          id,
        }));
        break;

      case 'tasks.cancel':
        ws.send(JSON.stringify({ type: 'tasks.list', payload: TEST_TASKS, id }));
        break;

      case 'memory.search':
        ws.send(JSON.stringify({
          type: 'memory.results',
          payload: [
            { content: `Search result for "${payload.query}"`, timestamp: Date.now() - 60000, role: 'assistant' },
          ],
          id,
        }));
        break;

      case 'memory.sessions':
        ws.send(JSON.stringify({
          type: 'memory.sessions',
          payload: [
            { id: 'session:abc123', messageCount: 12, lastActiveAt: Date.now() - 300000 },
            { id: 'session:def456', messageCount: 5, lastActiveAt: Date.now() - 3600000 },
          ],
          id,
        }));
        break;

      case 'approval.respond':
        console.log(`  Approval: ${payload.requestId} → ${payload.approved ? 'approved' : 'denied'}`);
        break;

      case 'config.get':
        ws.send(JSON.stringify({
          type: 'config.get',
          payload: DEFAULT_CONFIG,
          id,
        }));
        break;

      case 'config.set':
        ws.send(JSON.stringify({
          type: 'config.set',
          payload: { config: payload },
          id,
        }));
        break;

      case 'ollama.models':
        ws.send(JSON.stringify({
          type: 'ollama.models',
          payload: { models: OLLAMA_MODELS },
          id,
        }));
        break;

      case 'agents.list':
        ws.send(JSON.stringify({
          type: 'agents.list',
          payload: TEST_AGENTS,
          id,
        }));
        break;

      case 'wallet.info':
        ws.send(JSON.stringify({
          type: 'wallet.info',
          payload: {
            address: '8uM6m....DemoWallet',
            lamports: 12_500_000_000,
            sol: 12.5,
            network: 'devnet',
            rpcUrl: 'https://api.devnet.solana.com',
            explorerUrl: 'https://explorer.solana.com/address/8uM6m....DemoWallet',
          },
          id,
        }));
        break;

      case 'wallet.airdrop':
        ws.send(JSON.stringify({
          type: 'wallet.airdrop',
          payload: {
            requestId: payload.requestId,
            newLamports: 12_800_000_000,
            newBalance: 12.8,
          },
          id,
        }));
        break;

      case 'events.subscribe':
        setTimeout(() => {
          ws.send(JSON.stringify({
            type: 'events.event',
            payload: {
              eventType: 'taskCreated',
              data: { taskId: 'task_new', creator: 'Agent1', reward: 1000000 },
              timestamp: Date.now(),
            },
          }));
        }, 3000);
        break;

      case 'events.unsubscribe':
        break;

      case 'desktop.list':
        ws.send(JSON.stringify({
          type: 'desktop.list',
          payload: [],
          id,
        }));
        break;

      case 'desktop.create':
        ws.send(JSON.stringify({
          type: 'desktop.created',
          payload: {
            containerId: `desktop_${nextSandboxId++}`,
            sessionId: payload.sessionId ?? CHAT_SESSION_ID,
            status: 'ready',
            createdAt: Date.now(),
            lastActivityAt: Date.now(),
            vncUrl: `https://example.invalid/${nextSandboxId - 1}`,
            uptimeMs: 1200,
          },
          id,
        }));
        break;

      case 'desktop.destroy':
        ws.send(JSON.stringify({
          type: 'desktop.destroyed',
          payload: { containerId: payload.containerId ?? 'unknown' },
          id,
        }));
        break;

      default:
        ws.send(JSON.stringify({ type: 'error', error: `Unknown type: ${msg.type}`, id }));
    }
  });

  // Emit an approval request per connected client after a short delay so
  // each page gets its own banner in end-to-end tests.
  setTimeout(() => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        type: 'approval.request',
        payload: {
          requestId: `approval_${Math.random().toString(36).slice(2, 10)}`,
          action: 'jupiter.swap',
          details: { fromToken: 'SOL', toToken: 'USDC', amount: '1.5' },
        },
      }));
      console.log(`[!] Sent sample approval request to ${clientId}`);
    }
  }, 10_000);

  ws.on('close', () => {
    clients.delete(clientId);
    console.log(`[-] ${clientId} disconnected`);
  });
});

const startTime = Date.now();
