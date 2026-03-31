/**
 * Concordia simulation bridge — built into the daemon.
 *
 * Starts an HTTP server on port 3200 that the Python Concordia engine
 * talks to via ProxyEntity. Agent actions are routed through the daemon's
 * existing ChatExecutor pipeline (Grok, memory, identity, tools).
 *
 * Also starts a WebSocket event server on port 3201 for the React viewer.
 *
 * @module
 */

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { Logger } from "../utils/logger.js";

export interface ConcordiaBridgeConfig {
  readonly enabled?: boolean;
  readonly bridgePort?: number;
  readonly eventPort?: number;
}

interface ConcordiaBridgeContext {
  readonly logger: Logger;
  readonly sendMessage: (agentId: string, content: string) => Promise<string>;
  readonly generateAgents: (count: number, premise: string) => Promise<Array<{
    id: string;
    name: string;
    personality: string;
    goal: string;
  }>>;
}

interface AgentState {
  name: string;
  personality: string;
  goal: string;
  observations: string[];
  turns: number;
  lastAction: string | null;
  relationships: Record<string, { count: number; sentiment: number }>;
}

// ============================================================================
// Bridge server
// ============================================================================

export class ConcordiaBridge {
  private httpServer: Server | null = null;
  private readonly agents = new Map<string, AgentState>();
  private readonly worldFacts: Array<{ content: string; observedBy: string; confirmations: number; timestamp: number }> = [];
  private readonly logger: Logger;
  private readonly ctx: ConcordiaBridgeContext;
  private readonly bridgePort: number;
  private startTime = Date.now();

  constructor(config: ConcordiaBridgeConfig, ctx: ConcordiaBridgeContext) {
    this.logger = ctx.logger;
    this.ctx = ctx;
    this.bridgePort = config.bridgePort ?? 3200;
  }

  async start(): Promise<void> {
    this.startTime = Date.now();
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        this.logger.error?.("Concordia bridge error:", err);
        this.sendJson(res, 500, { error: String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.on("error", reject);
      this.httpServer!.listen(this.bridgePort, "0.0.0.0", () => {
        this.logger.info?.(`Concordia bridge listening on 0.0.0.0:${this.bridgePort}`);
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
      this.httpServer = null;
    }
  }

  // ==========================================================================
  // Request routing
  // ==========================================================================

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // CORS
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(200);
      res.end();
      return;
    }

    const path = req.url ?? "/";

    if (req.method === "GET") {
      if (path === "/health") return this.handleHealth(res);
      if (path === "/metrics") return this.handleMetrics(res);
      if (path.startsWith("/agent/") && path.endsWith("/state")) {
        const agentId = decodeURIComponent(path.split("/")[2]);
        return this.handleAgentState(agentId, res);
      }
      return this.sendJson(res, 404, { error: "Not found" });
    }

    if (req.method === "POST") {
      const body = await this.readJson(req);
      if (path === "/setup") return this.handleSetup(body, res);
      if (path === "/act") return this.handleAct(body, res);
      if (path === "/observe") return this.handleObserve(body, res);
      if (path === "/event") return this.handleEvent(body, res);
      if (path === "/generate-agents") return this.handleGenerateAgents(body, res);
      if (path === "/reset") { this.agents.clear(); this.worldFacts.length = 0; return this.sendJson(res, 200, { status: "ok" }); }
      return this.sendJson(res, 404, { error: "Not found" });
    }

    this.sendJson(res, 405, { error: "Method not allowed" });
  }

  // ==========================================================================
  // POST handlers
  // ==========================================================================

  private handleSetup(body: Record<string, unknown>, res: ServerResponse): void {
    this.agents.clear();
    this.worldFacts.length = 0;

    const agents = body.agents as Array<Record<string, string>> ?? [];
    const sessions: Record<string, string> = {};

    for (const agent of agents) {
      const id = agent.agent_id;
      this.agents.set(id, {
        name: agent.agent_name ?? id,
        personality: agent.personality ?? "",
        goal: agent.goal ?? "",
        observations: [],
        turns: 0,
        lastAction: null,
        relationships: {},
      });
      sessions[id] = `concordia:${id}`;
    }

    const premise = String(body.premise ?? "");
    if (premise) {
      this.worldFacts.push({
        content: premise,
        observedBy: "GM",
        confirmations: 0,
        timestamp: Date.now(),
      });
    }

    this.logger.info?.(
      `Concordia bridge: setup ${agents.length} agents, ` +
      `maxSteps=${body.max_steps ?? body.maxSteps ?? 20}, ` +
      `world=${body.world_id ?? "default"}`,
    );

    this.sendJson(res, 200, { status: "ok", sessions });
  }

  private async handleAct(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const agentId = String(body.agent_id ?? "");
    const agentName = String(body.agent_name ?? "");
    const spec = body.action_spec as Record<string, unknown> ?? {};
    const callToAction = String(spec.call_to_action ?? "What would you do?");
    const outputType = String(spec.output_type ?? "free");
    const options = (spec.options as string[]) ?? [];

    const agent = this.agents.get(agentId);
    if (agent) agent.turns++;

    // Build prompt
    let prompt: string;
    if (outputType === "choice" && options.length > 0) {
      prompt = `${callToAction}\n\nChoose EXACTLY one:\n${options.map((o) => `- ${o}`).join("\n")}\n\nRespond with only the chosen option.`;
    } else {
      prompt = `${callToAction}\n\nRespond concisely (1-2 sentences). Do not include your name.`;
    }

    // Route through daemon's ChatExecutor
    let action = await this.ctx.sendMessage(agentId, prompt);

    // Strip name prefix
    if (action.startsWith(`${agentName}: `)) {
      action = action.slice(agentName.length + 2);
    }

    // Fuzzy match for choice
    if (outputType === "choice" && options.length > 0) {
      const lower = action.toLowerCase().trim();
      const match = options.find((o) =>
        o.toLowerCase() === lower ||
        lower.includes(o.toLowerCase()) ||
        o.toLowerCase().includes(lower)
      );
      action = match ?? options[0];
    }

    if (agent) agent.lastAction = action;

    this.sendJson(res, 200, { action });
  }

  private handleObserve(body: Record<string, unknown>, res: ServerResponse): void {
    const agentId = String(body.agent_id ?? "");
    const observation = String(body.observation ?? "");
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.observations.push(observation);
      if (agent.observations.length > 50) {
        agent.observations.splice(0, agent.observations.length - 50);
      }
    }
    this.sendJson(res, 200, { status: "ok" });
  }

  private handleEvent(body: Record<string, unknown>, res: ServerResponse): void {
    const content = String(body.content ?? "");
    const acting = String(body.acting_agent ?? "");

    if (acting && content) {
      const actingAgent = this.agents.get(acting);
      if (actingAgent) {
        for (const [id, agent] of this.agents) {
          if (id !== acting && content.toLowerCase().includes(id.toLowerCase())) {
            if (!actingAgent.relationships[id]) {
              actingAgent.relationships[id] = { count: 0, sentiment: 0 };
            }
            actingAgent.relationships[id].count++;
          }
        }
      }

      if (body.type === "resolution") {
        this.worldFacts.push({
          content: content.slice(0, 200),
          observedBy: acting || "GM",
          confirmations: 0,
          timestamp: Date.now(),
        });
        if (this.worldFacts.length > 20) {
          this.worldFacts.splice(0, this.worldFacts.length - 20);
        }
      }
    }

    this.sendJson(res, 200, { status: "ok" });
  }

  private async handleGenerateAgents(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const count = Math.min(10, Math.max(2, Number(body.count) || 3));
    const premise = String(body.premise ?? "");

    const agents = await this.ctx.generateAgents(count, premise);
    this.sendJson(res, 200, { agents });
  }

  // ==========================================================================
  // GET handlers
  // ==========================================================================

  private handleHealth(res: ServerResponse): void {
    this.sendJson(res, 200, {
      status: "ok",
      active_sessions: this.agents.size,
      uptime_ms: Date.now() - this.startTime,
    });
  }

  private handleMetrics(res: ServerResponse): void {
    let totalTurns = 0;
    let totalObs = 0;
    for (const agent of this.agents.values()) {
      totalTurns += agent.turns;
      totalObs += agent.observations.length;
    }
    this.sendJson(res, 200, {
      act_requests: totalTurns,
      observe_requests: totalObs,
      active_sessions: this.agents.size,
    });
  }

  private handleAgentState(agentId: string, res: ServerResponse): void {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return this.sendJson(res, 404, { error: `Agent ${agentId} not found` });
    }

    const relationships = Object.entries(agent.relationships).map(([otherId, data]) => ({
      otherAgentId: otherId,
      relationship: "acquaintance",
      sentiment: data.sentiment,
      interactionCount: data.count,
    }));

    this.sendJson(res, 200, {
      identity: {
        name: agent.name,
        personality: agent.personality,
        learnedTraits: [],
        beliefs: {},
      },
      memoryCount: agent.observations.length,
      recentMemories: agent.observations.slice(-5).map((obs) => ({
        content: obs.slice(0, 200),
        role: "system",
        timestamp: Date.now(),
      })),
      relationships,
      worldFacts: this.worldFacts.slice(-5),
      turnCount: agent.turns,
      lastAction: agent.lastAction,
    });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private sendJson(res: ServerResponse, status: number, data: unknown): void {
    const body = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
      "Access-Control-Allow-Origin": "*",
    });
    res.end(body);
  }

  private readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        try {
          const body = Buffer.concat(chunks).toString("utf-8");
          resolve(body ? JSON.parse(body) : {});
        } catch (err) {
          reject(new Error(`Invalid JSON: ${err}`));
        }
      });
      req.on("error", reject);
    });
  }
}
