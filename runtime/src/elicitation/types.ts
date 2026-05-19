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

export interface RequestUserInputArgs {
  readonly questions: readonly RequestUserInputQuestion[];
}

export interface RequestUserInputAnswer {
  readonly answers: readonly string[];
}

export interface RequestUserInputResponse {
  readonly answers: Readonly<Record<string, RequestUserInputAnswer>>;
}

export interface RequestUserInputEvent {
  readonly requestId: string;
  readonly callId: string;
  readonly turnId: string;
  readonly questions: readonly RequestUserInputQuestion[];
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
