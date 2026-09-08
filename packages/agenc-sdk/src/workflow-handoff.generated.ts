import { validateHandoffStructure, validateHandoffRelationships } from "./workflow-handoff-validation.js";
export { WorkflowHandoffArtifactValidationError } from "./workflow-handoff-validation.js";

export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_FORMAT_VERSION = 1 as const;
export const AGENC_WORKFLOW_HANDOFF_ARTIFACT_KIND = "workflow_handoff" as const;
export const AGENC_WORKFLOW_HANDOFF_COMPATIBILITY_EPOCH = "workflow_handoff.v1/state-schema.22" as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_ARTIFACT_BYTES = 16777216 as const;
export const AGENC_MAX_WORKFLOW_STEP_RESULT_TOKENS = 131072 as const;
export const AGENC_MAX_WORKFLOW_STEP_PREVIEW_BYTES = 2048 as const;
export const AGENC_MAX_WORKFLOW_HANDOFF_OWNER_FIELD_UTF8_BYTES = 1024 as const;

export interface WorkflowHandoffOwner {
  readonly run_id: string;
  readonly workflow_id: string;
  readonly producer_step_id: string;
}

export interface WorkflowHandoffArtifact {
  readonly format_version: 1;
  readonly kind: "workflow_handoff";
  readonly compatibility_epoch: "workflow_handoff.v1/state-schema.22";
  readonly artifact_id: string;
  readonly owner: WorkflowHandoffOwner;
  readonly digest: `sha256:${string}`;
  readonly byte_length: number;
  readonly token_count: number;
  readonly media_type: "text/plain";
  readonly encoding: "utf-8";
  readonly storage_ref: string;
  readonly created_at_ms: number;
  readonly committed_at_ms: number;
  readonly commit_sequence: number;
  readonly preview: string;
  readonly preview_truncated: boolean;
}

const artifactSchema = {
  "type": "object",
  "additionalProperties": false,
  "required": [
    "format_version",
    "kind",
    "compatibility_epoch",
    "artifact_id",
    "owner",
    "digest",
    "byte_length",
    "token_count",
    "media_type",
    "encoding",
    "storage_ref",
    "created_at_ms",
    "committed_at_ms",
    "commit_sequence",
    "preview",
    "preview_truncated"
  ],
  "properties": {
    "format_version": {
      "const": 1
    },
    "kind": {
      "const": "workflow_handoff"
    },
    "compatibility_epoch": {
      "const": "workflow_handoff.v1/state-schema.22"
    },
    "artifact_id": {
      "type": "string",
      "pattern": "^wh_[0-9a-f]{48}$"
    },
    "owner": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "run_id",
        "workflow_id",
        "producer_step_id"
      ],
      "properties": {
        "run_id": {
          "type": "string",
          "minLength": 1
        },
        "workflow_id": {
          "type": "string",
          "minLength": 1
        },
        "producer_step_id": {
          "type": "string",
          "minLength": 1
        }
      }
    },
    "digest": {
      "type": "string",
      "pattern": "^sha256:[0-9a-f]{64}$"
    },
    "byte_length": {
      "type": "integer",
      "minimum": 0,
      "maximum": 16777216
    },
    "token_count": {
      "type": "integer",
      "minimum": 0,
      "maximum": 131072
    },
    "media_type": {
      "const": "text/plain"
    },
    "encoding": {
      "const": "utf-8"
    },
    "storage_ref": {
      "type": "string",
      "pattern": "^workflow-handoff:wh_[0-9a-f]{48}$"
    },
    "created_at_ms": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "committed_at_ms": {
      "type": "integer",
      "minimum": 0,
      "maximum": 9007199254740991
    },
    "commit_sequence": {
      "type": "integer",
      "minimum": 1,
      "maximum": 9007199254740991
    },
    "preview": {
      "type": "string"
    },
    "preview_truncated": {
      "type": "boolean"
    }
  }
} as const;
const postValidation = {
  "ownerFieldMaxUtf8Bytes": 1024,
  "previewMaxUtf8Bytes": 2048,
  "requireWellFormedUnicode": true,
  "storageRefMustMatchArtifactId": true,
  "committedAtMustNotPrecedeCreatedAt": true,
  "previewBytesMustMatchByteLengthAndTruncation": true
} as const;

export function validateWorkflowHandoffArtifact(value: unknown): WorkflowHandoffArtifact {
  validateHandoffStructure(value, artifactSchema, "workflow handoff artifact");
  const artifact = value as WorkflowHandoffArtifact;
  validateHandoffRelationships(artifact, postValidation);
  return artifact;
}
