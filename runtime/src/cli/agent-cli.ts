import { Connection, PublicKey } from "@solana/web3.js";
import type {
  BaseCliOptions,
  CliRuntimeContext,
  CliStatusCode,
} from "./types.js";
import { createAgencTools } from "../tools/agenc/index.js";
import {
  getDefaultKeypairPath,
  keypairToWallet,
  loadKeypairFromFile,
} from "../types/wallet.js";

export interface AgentRegisterOptions extends BaseCliOptions {
  capabilities?: string;
  endpoint?: string;
  metadataUri?: string;
  agentId?: string;
}

function parseResultContent(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    return { raw: content };
  }
}

function extractErrorMessage(payload: unknown, fallback: string): string {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "error" in payload &&
    typeof (payload as { error?: unknown }).error === "string"
  ) {
    return (payload as { error: string }).error;
  }
  return fallback;
}

export async function runAgentRegisterCommand(
  context: CliRuntimeContext,
  options: AgentRegisterOptions,
): Promise<CliStatusCode> {
  if (!options.rpcUrl) {
    context.error({
      status: "error",
      code: "MISSING_REQUIRED_OPTION",
      message: "agent register requires --rpc or AGENC_RUNTIME_RPC_URL",
    });
    return 2;
  }

  try {
    const keypairPath =
      process.env.SOLANA_KEYPAIR_PATH ?? getDefaultKeypairPath();
    const keypair = await loadKeypairFromFile(keypairPath);
    const wallet = keypairToWallet(keypair);
    const tool = createAgencTools({
      connection: new Connection(options.rpcUrl, "confirmed"),
      wallet,
      programId: options.programId
        ? new PublicKey(options.programId)
        : undefined,
      logger: context.logger,
    }).find((candidate) => candidate.name === "agenc.registerAgent");

    if (!tool) {
      context.error({
        status: "error",
        code: "AGENT_REGISTER_UNAVAILABLE",
        message: "agenc.registerAgent tool is not available",
      });
      return 1;
    }

    const result = await tool.execute({
      capabilities: options.capabilities,
      endpoint: options.endpoint,
      metadataUri: options.metadataUri,
      agentId: options.agentId,
    });
    const payload = parseResultContent(result.content);

    if (result.isError) {
      context.error({
        status: "error",
        command: "agent.register",
        code: "AGENT_REGISTER_FAILED",
        message: extractErrorMessage(payload, result.content),
        authority: wallet.publicKey.toBase58(),
        keypairPath,
      });
      return 1;
    }

    context.output({
      status: "ok",
      command: "agent.register",
      schema: "agent.register.output.v1",
      authority: wallet.publicKey.toBase58(),
      keypairPath,
      result: payload,
    });
    return 0;
  } catch (error) {
    context.error({
      status: "error",
      command: "agent.register",
      code: "AGENT_REGISTER_FAILED",
      message: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}
