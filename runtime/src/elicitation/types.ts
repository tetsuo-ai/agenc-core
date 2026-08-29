/**
 * Ports the donor runtime's request-user-input and MCP elicitation protocol
 * shapes onto AgenC's TypeScript event and tool surfaces.
 *
 * Why this lives here / shape difference from upstream:
 *   - The donor splits protocol structs, tool schema helpers, and MCP client
 *     service callbacks across separate crates; AgenC keeps the shared wire
 *     types together so session, MCP, and model-facing tools agree.
 *
 * Cross-cuts deliberately NOT carried:
 *   - URL browser automation. URL elicitations are surfaced as events; a UI
 *     owner decides how to open and complete the out-of-band flow.
 *
 * @module
 */

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";

/**
 * Capability advertised by an initialized portal client that can present a
 * Solana transfer on a physically-connected Ledger device.
 */
export const LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY =
  "portal.ledger.solana.sign.v1" as const;

export interface RequestUserInputQuestionOption {
  readonly label: string;
  readonly description: string;
}

export interface RequestUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly isOther: boolean;
  readonly isSecret: boolean;
  readonly options?: readonly RequestUserInputQuestionOption[];
}

/**
 * Machine-readable client action produced exclusively by the built-in Ledger
 * transfer tool. `lamports` deliberately stays decimal text so JSON consumers
 * never lose integer precision.
 */
export interface LedgerSolanaTransferClientAction {
  readonly type: "ledger_solana_transfer_v1";
  readonly source: "agenc-core";
  readonly targetCapability: typeof LEDGER_SOLANA_SIGN_CLIENT_CAPABILITY;
  readonly network: "mainnet-beta";
  readonly intentId: string;
  /**
   * High-entropy, Core-generated challenge that the capability-routed phone
   * must echo in its receipt. It is never returned to the model.
   */
  readonly responseNonce: string;
  readonly to: string;
  readonly lamports: string;
  readonly note?: string;
  readonly expiresAt: string;
}

export type RequestUserInputClientAction = LedgerSolanaTransferClientAction;

/**
 * Typed result emitted only by a client that received a Ledger transfer
 * action. Core still binds every field to the original action before exposing
 * a nonce-free result to the model.
 */
export type LedgerSolanaTransferClientResult =
  | {
      readonly type: "ledger_solana_transfer_receipt_v1";
      readonly intentId: string;
      readonly responseNonce: string;
      readonly status: "submitted";
      readonly network: "mainnet-beta";
      readonly to: string;
      readonly lamports: string;
      readonly from: string;
      readonly signature: string;
    }
  | {
      readonly type: "ledger_solana_transfer_receipt_v1";
      readonly intentId: string;
      readonly responseNonce: string;
      readonly status: "cancelled";
      readonly network: "mainnet-beta";
      readonly to: string;
      readonly lamports: string;
      readonly from?: string;
      readonly reason: string;
    };

export type RequestUserInputClientResult = LedgerSolanaTransferClientResult;

export interface RequestUserInputArgs {
  readonly questions: readonly RequestUserInputQuestion[];
  /** Internal-only: the generic request_user_input model schema cannot set it. */
  readonly clientAction?: RequestUserInputClientAction;
}

export interface RequestUserInputAnswer {
  readonly answers: readonly string[];
}

export interface RequestUserInputResponse {
  readonly answers: Readonly<Record<string, RequestUserInputAnswer>>;
  /** Trusted client result kept separate from model-compatible free-text answers. */
  readonly clientResult?: RequestUserInputClientResult;
}

export interface RequestUserInputEvent {
  readonly requestId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly questions: readonly RequestUserInputQuestion[];
  readonly clientAction?: RequestUserInputClientAction;
}

export type McpRequestId = string | number;

export interface McpTitledEnumValue {
  readonly const: string;
  readonly title?: string;
  readonly description?: string;
}

export type McpPrimitiveSchemaDefinition =
  | {
      readonly type: "string";
      readonly title?: string;
      readonly description?: string;
      readonly minLength?: number;
      readonly maxLength?: number;
      readonly format?: string;
      readonly enum?: readonly string[];
      readonly enumNames?: readonly string[];
      readonly oneOf?: readonly McpTitledEnumValue[];
      readonly anyOf?: readonly McpTitledEnumValue[];
    }
  | {
      readonly type: "number" | "integer";
      readonly title?: string;
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | {
      readonly type: "boolean";
      readonly title?: string;
      readonly description?: string;
      readonly default?: boolean;
    }
  | {
      readonly type: "array";
      readonly title?: string;
      readonly description?: string;
      readonly items: {
        readonly type?: "string";
        readonly enum?: readonly string[];
        readonly enumNames?: readonly string[];
        readonly anyOf?: readonly McpTitledEnumValue[];
      };
      readonly uniqueItems?: boolean;
      readonly minItems?: number;
      readonly maxItems?: number;
    };

export interface McpElicitationFormRequest {
  readonly mode: "form";
  readonly message: string;
  readonly requestedSchema: {
    readonly type: "object";
    readonly properties: Readonly<Record<string, McpPrimitiveSchemaDefinition>>;
    readonly required?: readonly string[];
  };
  readonly meta?: Readonly<Record<string, unknown>>;
}

export interface McpElicitationUrlRequest {
  readonly mode: "url";
  readonly message: string;
  readonly elicitationId: string;
  readonly url: string;
  readonly meta?: Readonly<Record<string, unknown>>;
}

export type McpElicitationRequest =
  | McpElicitationFormRequest
  | McpElicitationUrlRequest;

export type McpElicitationAction = "accept" | "decline" | "cancel";

export interface McpElicitationResponse {
  readonly action: McpElicitationAction;
  readonly content?: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly meta?: unknown;
}

export interface McpElicitationRequestEvent {
  readonly turnId: string;
  readonly serverName: string;
  readonly requestId: McpRequestId;
  readonly request: McpElicitationRequest;
}

export interface McpElicitationCompleteEvent {
  readonly serverName: string;
  readonly elicitationId: string;
}
