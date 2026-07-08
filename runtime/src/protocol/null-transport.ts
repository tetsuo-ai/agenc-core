/**
 * A1 — NullTransport: the revert-safe default `ProtocolTransport`.
 *
 * Constructed whenever `[protocol]` is disabled (the default) or the
 * adapter kind is `"null"`. Every method returns a typed error — the
 * read-only verbs report `TRANSPORT_NOT_CONFIGURED`, so the command
 * layer can keep emitting today's honest "not attached" stub text, and
 * the mutating verbs are owner-gated exactly like every other
 * implementation.
 *
 * @module
 */

import type {
  ClaimableTaskList,
  ListClaimableOptions,
  ProtocolResult,
  ProtocolTransport,
  TaskDetail,
} from "./types.js";
import { protocolError } from "./types.js";

const NOT_CONFIGURED_MESSAGE =
  "Protocol transport is not configured — enable [protocol] with adapter " +
  "\"marketplace-cli\" in config.toml to browse marketplace tasks (read-only).";

const OWNER_GATED_MESSAGE =
  "This protocol verb mutates on-chain state and is owner-gated: it is not " +
  "enabled in this runtime and requires explicit owner approval through a " +
  "signing flow outside this process.";

function notConfigured(): Promise<ProtocolResult<never>> {
  return Promise.resolve(
    protocolError("TRANSPORT_NOT_CONFIGURED", NOT_CONFIGURED_MESSAGE),
  );
}

function ownerGated(): Promise<ProtocolResult<never>> {
  return Promise.resolve(protocolError("VERB_NOT_ENABLED", OWNER_GATED_MESSAGE));
}

export class NullTransport implements ProtocolTransport {
  readonly kind = "null";

  listClaimable(
    _opts?: ListClaimableOptions,
  ): Promise<ProtocolResult<ClaimableTaskList>> {
    return notConfigured();
  }

  taskDetail(_taskPda: string): Promise<ProtocolResult<TaskDetail>> {
    return notConfigured();
  }

  claimTask(_taskPda: string): Promise<ProtocolResult<never>> {
    return ownerGated();
  }

  delegateStep(_agent: string, _step: string): Promise<ProtocolResult<never>> {
    return ownerGated();
  }

  submitProof(_target?: string): Promise<ProtocolResult<never>> {
    return ownerGated();
  }

  settleTask(_taskPda?: string): Promise<ProtocolResult<never>> {
    return ownerGated();
  }

  adjustStake(_amount?: string): Promise<ProtocolResult<never>> {
    return ownerGated();
  }
}
