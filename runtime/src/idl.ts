/**
 * AgenC Coordination Program IDL and Program Factory Functions
 *
 * Runtime intentionally keeps this local module path stable, but canonical
 * protocol ownership now lives in the published `@tetsuo-ai/protocol` package.
 *
 * The raw IDL JSON uses snake_case names. We export it typed as Anchor's
 * generic `Idl` type which correctly represents this structure. The
 * `AgencCoordination` type is only used for `Program<T>` generics where
 * Anchor handles the snake_case to camelCase mapping internally.
 */

import { Program, AnchorProvider, Idl } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  AGENC_COORDINATION_IDL,
  type AgencCoordination,
} from "@tetsuo-ai/protocol";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";

/** Re-export the IDL type for Program<T> generics */
export type { AgencCoordination };

type NamedIdlEntry = { name: string };
type NamedIdlInstruction = NamedIdlEntry & { accounts?: unknown[] };
export type ProgramLayoutMode =
  | "default"
  | "legacyInitiateDispute"
  | "legacyCreateTask";

// The published protocol package currently diverges from the deployed
// marketplace/task-dispute account layouts on devnet. Override the stale
// account metadata here so Anchor derives and validates the correct accounts
// without requiring a package release first.
const MARKETPLACE_ACCOUNT_LAYOUT_OVERRIDES = {
  create_task: [
    {
      name: "task",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [116, 97, 115, 107] },
          { kind: "account", path: "creator" },
          { kind: "arg", path: "task_id" },
        ],
      },
    },
    {
      name: "escrow",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [101, 115, 99, 114, 111, 119] },
          { kind: "account", path: "task" },
        ],
      },
    },
    {
      name: "protocol_config",
      writable: true,
      pda: {
        seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
      },
    },
    {
      name: "creator_agent",
      docs: ["Creator's agent registration for identity/authorization checks"],
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [97, 103, 101, 110, 116] },
          {
            kind: "account",
            path: "creator_agent.agent_id",
            account: "AgentRegistration",
          },
        ],
      },
    },
    {
      name: "authority_rate_limit",
      docs: ["Wallet-scoped task/dispute rate limit state shared across all agents"],
      writable: true,
      pda: {
        seeds: [
          {
            kind: "const",
            value: [
              97, 117, 116, 104, 111, 114, 105, 116, 121, 95, 114, 97, 116, 101, 95, 108, 105,
              109, 105, 116,
            ],
          },
          { kind: "account", path: "authority" },
        ],
      },
    },
    {
      name: "authority",
      docs: ["The authority that owns the creator_agent"],
      signer: true,
      relations: ["creator_agent"],
    },
    {
      name: "creator",
      docs: [
        "The creator who pays for and owns the task",
        "Must match authority to prevent social engineering attacks (#375)",
      ],
      writable: true,
      signer: true,
    },
    {
      name: "system_program",
      address: "11111111111111111111111111111111",
    },
    {
      name: "reward_mint",
      docs: ["SPL token mint for reward denomination (optional)"],
      optional: true,
    },
    {
      name: "creator_token_account",
      docs: ["Creator's token account holding reward tokens (optional)"],
      writable: true,
      optional: true,
    },
    {
      name: "token_escrow_ata",
      docs: [
        "Escrow's associated token account for holding reward tokens (optional).",
        "Created via ATA CPI during handler if token task.",
      ],
      writable: true,
      optional: true,
    },
    {
      name: "token_program",
      docs: ["SPL Token program (optional, required for token tasks)"],
      optional: true,
      address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
    {
      name: "associated_token_program",
      docs: [
        "Associated Token Account program (optional, required for token tasks)",
      ],
      optional: true,
      address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    },
  ],
  create_dependent_task: [
    {
      name: "task",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [116, 97, 115, 107] },
          { kind: "account", path: "creator" },
          { kind: "arg", path: "task_id" },
        ],
      },
    },
    {
      name: "escrow",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [101, 115, 99, 114, 111, 119] },
          { kind: "account", path: "task" },
        ],
      },
    },
    {
      name: "parent_task",
      docs: [
        "The parent task this new task depends on",
        "Note: Uses Box to reduce stack usage for this large account",
      ],
    },
    {
      name: "protocol_config",
      docs: ["Note: Uses Box to reduce stack usage for this large account"],
      writable: true,
      pda: {
        seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
      },
    },
    {
      name: "creator_agent",
      docs: ["Creator's agent registration for identity/authorization checks"],
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [97, 103, 101, 110, 116] },
          {
            kind: "account",
            path: "creator_agent.agent_id",
            account: "AgentRegistration",
          },
        ],
      },
    },
    {
      name: "authority_rate_limit",
      docs: ["Wallet-scoped task/dispute rate limit state shared across all agents"],
      writable: true,
      pda: {
        seeds: [
          {
            kind: "const",
            value: [
              97, 117, 116, 104, 111, 114, 105, 116, 121, 95, 114, 97, 116, 101, 95, 108, 105,
              109, 105, 116,
            ],
          },
          { kind: "account", path: "authority" },
        ],
      },
    },
    {
      name: "authority",
      docs: ["The authority that owns the creator_agent"],
      signer: true,
      relations: ["creator_agent"],
    },
    {
      name: "creator",
      docs: [
        "The creator who pays for and owns the task",
        "Must match authority to prevent social engineering attacks (#375)",
      ],
      writable: true,
      signer: true,
    },
    {
      name: "system_program",
      address: "11111111111111111111111111111111",
    },
    {
      name: "reward_mint",
      docs: ["SPL token mint for reward denomination (optional)"],
      optional: true,
    },
    {
      name: "creator_token_account",
      docs: ["Creator's token account holding reward tokens (optional)"],
      writable: true,
      optional: true,
    },
    {
      name: "token_escrow_ata",
      docs: ["Escrow's associated token account for holding reward tokens (optional)."],
      writable: true,
      optional: true,
    },
    {
      name: "token_program",
      docs: ["SPL Token program (optional, required for token tasks)"],
      optional: true,
      address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    },
    {
      name: "associated_token_program",
      docs: [
        "Associated Token Account program (optional, required for token tasks)",
      ],
      optional: true,
      address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
    },
  ],
  initiate_dispute: [
    {
      name: "dispute",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [100, 105, 115, 112, 117, 116, 101] },
          { kind: "arg", path: "dispute_id" },
        ],
      },
    },
    {
      name: "task",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [116, 97, 115, 107] },
          { kind: "account", path: "task.creator", account: "Task" },
          { kind: "account", path: "task.task_id", account: "Task" },
        ],
      },
    },
    {
      name: "agent",
      writable: true,
      pda: {
        seeds: [
          { kind: "const", value: [97, 103, 101, 110, 116] },
          { kind: "account", path: "agent.agent_id", account: "AgentRegistration" },
        ],
      },
    },
    {
      name: "authority_rate_limit",
      docs: ["Wallet-scoped task/dispute rate limit state shared across all agents"],
      writable: true,
      pda: {
        seeds: [
          {
            kind: "const",
            value: [
              97, 117, 116, 104, 111, 114, 105, 116, 121, 95, 114, 97, 116, 101, 95, 108, 105,
              109, 105, 116,
            ],
          },
          { kind: "account", path: "authority" },
        ],
      },
    },
    {
      name: "protocol_config",
      pda: {
        seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
      },
    },
    {
      name: "initiator_claim",
      docs: ["Optional: Initiator's claim if they are a worker (not the creator)"],
      optional: true,
      pda: {
        seeds: [
          { kind: "const", value: [99, 108, 97, 105, 109] },
          { kind: "account", path: "task" },
          { kind: "account", path: "agent" },
        ],
      },
    },
    {
      name: "worker_agent",
      docs: [
        "Optional: Worker agent to be disputed (required when initiator is task creator)",
      ],
      writable: true,
      optional: true,
    },
    {
      name: "worker_claim",
      docs: ["Optional: Worker's claim (required when worker_agent is provided)"],
      optional: true,
    },
    {
      name: "task_submission",
      docs: [
        "Optional durable submission record used once the claim slot has been released.",
      ],
      optional: true,
    },
    {
      name: "authority",
      writable: true,
      signer: true,
      relations: ["agent"],
    },
    {
      name: "system_program",
      address: "11111111111111111111111111111111",
    },
  ],
} as const;

const LEGACY_CREATE_TASK_ACCOUNT_LAYOUT = [
  ...MARKETPLACE_ACCOUNT_LAYOUT_OVERRIDES.create_task.slice(0, 4),
  ...MARKETPLACE_ACCOUNT_LAYOUT_OVERRIDES.create_task.slice(5),
];

const LEGACY_INITIATE_DISPUTE_ACCOUNT_LAYOUT = [
  {
    name: "dispute",
    writable: true,
    pda: {
      seeds: [
        { kind: "const", value: [100, 105, 115, 112, 117, 116, 101] },
        { kind: "arg", path: "dispute_id" },
      ],
    },
  },
  {
    name: "task",
    writable: true,
    pda: {
      seeds: [
        { kind: "const", value: [116, 97, 115, 107] },
        { kind: "account", path: "task.creator", account: "Task" },
        { kind: "account", path: "task.task_id", account: "Task" },
      ],
    },
  },
  {
    name: "agent",
    writable: true,
    pda: {
      seeds: [
        { kind: "const", value: [97, 103, 101, 110, 116] },
        {
          kind: "account",
          path: "agent.agent_id",
          account: "AgentRegistration",
        },
      ],
    },
  },
  {
    name: "protocol_config",
    pda: {
      seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
    },
  },
  {
    name: "initiator_claim",
    docs: ["Optional: Initiator's claim if they are a worker (not the creator)"],
    optional: true,
    pda: {
      seeds: [
        { kind: "const", value: [99, 108, 97, 105, 109] },
        { kind: "account", path: "task" },
        { kind: "account", path: "agent" },
      ],
    },
  },
  {
    name: "worker_agent",
    docs: [
      "Optional: Worker agent to be disputed (required when initiator is task creator)",
    ],
    writable: true,
    optional: true,
  },
  {
    name: "worker_claim",
    docs: ["Optional: Worker's claim (required when worker_agent is provided)"],
    optional: true,
  },
  {
    name: "authority",
    writable: true,
    signer: true,
    relations: ["agent"],
  },
  {
    name: "system_program",
    address: "11111111111111111111111111111111",
  },
] as const;

// The published protocol package can lag behind the runtime's supported V2 flow.
// Merge these entries in locally so Program.methods exposes the task validation
// instructions and accounts without requiring a package release first.
const TASK_VALIDATION_V2_INSTRUCTIONS = [
  {
    name: "configure_task_validation",
    docs: ["Enable Task Validation V2 creator review for an open task."],
    discriminator: [11, 79, 19, 188, 13, 32, 244, 90],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "task_validation_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_attestor_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 97, 116, 116, 101, 115, 116, 111, 114],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "protocol_config",
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      { name: "creator", writable: true, signer: true },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [
      { name: "mode", type: "u8" },
      { name: "review_window_secs", type: "i64" },
      { name: "validator_quorum", type: "u8" },
      { name: "attestor", type: { option: "pubkey" } },
    ],
  },
  {
    name: "submit_task_result",
    docs: ["Submit a result for manual validation before final settlement."],
    discriminator: [39, 108, 74, 4, 66, 125, 157, 7],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "worker" },
          ],
        },
      },
      {
        name: "task_validation_config",
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_submission",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 115, 117, 98, 109, 105, 115, 115, 105, 111, 110],
            },
            { kind: "account", path: "claim" },
          ],
        },
      },
      {
        name: "protocol_config",
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      {
        name: "worker",
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      {
        name: "authority",
        writable: true,
        signer: true,
        relations: ["worker"],
      },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [
      { name: "proof_hash", type: { array: ["u8", 32] } },
      { name: "result_data", type: { option: { array: ["u8", 64] } } },
    ],
  },
  {
    name: "accept_task_result",
    docs: ["Accept a creator-reviewed submission and settle rewards."],
    discriminator: [89, 230, 51, 25, 0, 219, 5, 137],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "worker" },
          ],
        },
      },
      {
        name: "escrow",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [101, 115, 99, 114, 111, 119] },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_validation_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_submission",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 115, 117, 98, 109, 105, 115, 115, 105, 111, 110],
            },
            { kind: "account", path: "claim" },
          ],
        },
      },
      {
        name: "worker",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      {
        name: "protocol_config",
        writable: true,
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      { name: "treasury", writable: true },
      { name: "creator", writable: true, signer: true },
      { name: "worker_authority", writable: true },
      { name: "token_escrow_ata", writable: true, optional: true },
      { name: "worker_token_account", writable: true, optional: true },
      { name: "treasury_token_account", writable: true, optional: true },
      { name: "reward_mint", optional: true },
      {
        name: "token_program",
        optional: true,
        address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [],
  },
  {
    name: "reject_task_result",
    docs: [
      "Reject a creator-reviewed submission and return the task to active work.",
    ],
    discriminator: [144, 7, 58, 232, 157, 167, 85, 214],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "claim.worker", account: "TaskClaim" },
          ],
        },
      },
      {
        name: "task_validation_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_submission",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 115, 117, 98, 109, 105, 115, 115, 105, 111, 110],
            },
            { kind: "account", path: "claim" },
          ],
        },
      },
      {
        name: "worker",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      {
        name: "protocol_config",
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      { name: "creator", writable: true, signer: true },
      { name: "worker_authority", writable: true },
    ],
    args: [{ name: "rejection_hash", type: { array: ["u8", 32] } }],
  },
  {
    name: "auto_accept_task_result",
    docs: [
      "Permissionlessly auto-accept a creator-reviewed submission after timeout.",
    ],
    discriminator: [217, 200, 76, 0, 144, 80, 23, 241],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "worker" },
          ],
        },
      },
      {
        name: "escrow",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [101, 115, 99, 114, 111, 119] },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_validation_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_submission",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 115, 117, 98, 109, 105, 115, 115, 105, 111, 110],
            },
            { kind: "account", path: "claim" },
          ],
        },
      },
      {
        name: "worker",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      {
        name: "protocol_config",
        writable: true,
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      { name: "treasury", writable: true },
      { name: "creator", writable: true },
      { name: "worker_authority", writable: true },
      { name: "authority", writable: true, signer: true },
      { name: "token_escrow_ata", writable: true, optional: true },
      { name: "worker_token_account", writable: true, optional: true },
      { name: "treasury_token_account", writable: true, optional: true },
      { name: "reward_mint", optional: true },
      {
        name: "token_program",
        optional: true,
        address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [],
  },
  {
    name: "validate_task_result",
    docs: [
      "Record a validator quorum vote or external attestation for a submission.",
    ],
    discriminator: [141, 192, 86, 228, 233, 168, 41, 224],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "worker" },
          ],
        },
      },
      {
        name: "escrow",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [101, 115, 99, 114, 111, 119] },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_validation_config",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_attestor_config",
        optional: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 97, 116, 116, 101, 115, 116, 111, 114],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "task_submission",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [116, 97, 115, 107, 95, 115, 117, 98, 109, 105, 115, 115, 105, 111, 110],
            },
            { kind: "account", path: "claim" },
          ],
        },
      },
      {
        name: "task_validation_vote",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [
                116, 97, 115, 107, 95, 118, 97, 108, 105, 100, 97, 116, 105, 111, 110, 95, 118,
                111, 116, 101,
              ],
            },
            { kind: "account", path: "task_submission" },
            { kind: "account", path: "reviewer" },
          ],
        },
      },
      {
        name: "worker",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      {
        name: "protocol_config",
        writable: true,
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      {
        name: "validator_agent",
        docs: [
          "Optional validator agent for validator-quorum mode, validated in handler.",
        ],
        optional: true,
      },
      { name: "treasury", writable: true },
      { name: "creator", writable: true },
      { name: "worker_authority", writable: true },
      { name: "reviewer", writable: true, signer: true },
      { name: "token_escrow_ata", writable: true, optional: true },
      { name: "worker_token_account", writable: true, optional: true },
      { name: "treasury_token_account", writable: true, optional: true },
      { name: "reward_mint", optional: true },
      {
        name: "token_program",
        optional: true,
        address: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [{ name: "approved", type: "bool" }],
  },
] as const;

const TASK_JOB_SPEC_INSTRUCTIONS = [
  {
    name: "set_task_job_spec",
    docs: ["Attach or update verified marketplace job spec metadata for a task."],
    discriminator: [134, 102, 102, 86, 31, 164, 202, 193],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "task_job_spec",
        writable: true,
        pda: {
          seeds: [
            {
              kind: "const",
              value: [
                116, 97, 115, 107, 95, 106, 111, 98, 95, 115, 112, 101, 99,
              ],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      { name: "creator", writable: true, signer: true },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [
      { name: "job_spec_hash", type: { array: ["u8", 32] } },
      { name: "job_spec_uri", type: "string" },
    ],
  },
  {
    name: "claim_task_with_job_spec",
    docs: ["Claim a task only when its verified marketplace job spec metadata exists."],
    discriminator: [230, 40, 107, 109, 208, 228, 175, 31],
    accounts: [
      {
        name: "task",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [116, 97, 115, 107] },
            { kind: "account", path: "task.creator", account: "Task" },
            { kind: "account", path: "task.task_id", account: "Task" },
          ],
        },
      },
      {
        name: "task_job_spec",
        pda: {
          seeds: [
            {
              kind: "const",
              value: [
                116, 97, 115, 107, 95, 106, 111, 98, 95, 115, 112, 101, 99,
              ],
            },
            { kind: "account", path: "task" },
          ],
        },
      },
      {
        name: "claim",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [99, 108, 97, 105, 109] },
            { kind: "account", path: "task" },
            { kind: "account", path: "worker" },
          ],
        },
      },
      {
        name: "protocol_config",
        pda: {
          seeds: [{ kind: "const", value: [112, 114, 111, 116, 111, 99, 111, 108] }],
        },
      },
      {
        name: "worker",
        writable: true,
        pda: {
          seeds: [
            { kind: "const", value: [97, 103, 101, 110, 116] },
            {
              kind: "account",
              path: "worker.agent_id",
              account: "AgentRegistration",
            },
          ],
        },
      },
      { name: "authority", writable: true, signer: true },
      {
        name: "system_program",
        address: "11111111111111111111111111111111",
      },
    ],
    args: [],
  },
] as const;

const TASK_VALIDATION_V2_ACCOUNTS = [
  {
    name: "TaskValidationConfig",
    discriminator: [101, 204, 19, 0, 210, 2, 191, 0],
  },
  {
    name: "TaskSubmission",
    discriminator: [111, 64, 190, 132, 148, 33, 215, 63],
  },
  {
    name: "TaskAttestorConfig",
    discriminator: [103, 130, 20, 87, 207, 120, 111, 34],
  },
  {
    name: "TaskValidationVote",
    discriminator: [48, 129, 51, 174, 154, 5, 68, 65],
  },
] as const;

const TASK_JOB_SPEC_ACCOUNTS = [
  {
    name: "TaskJobSpec",
    discriminator: [249, 63, 211, 94, 228, 165, 3, 196],
  },
] as const;

const TASK_JOB_SPEC_TYPES = [
  {
    name: "TaskJobSpec",
    docs: [
      "Verified marketplace job spec metadata for a task.",
      '["task_job_spec", task]',
    ],
    type: {
      kind: "struct",
      fields: [
        { name: "task", docs: ["Task this metadata belongs to."], type: "pubkey" },
        { name: "creator", docs: ["Task creator that published the metadata."], type: "pubkey" },
        { name: "job_spec_hash", docs: ["Canonical sha256 hash for the off-chain job spec envelope payload."], type: { array: ["u8", 32] } },
        { name: "job_spec_uri", docs: ["Canonical job spec URI."], type: "string" },
        { name: "created_at", docs: ["Creation timestamp."], type: "i64" },
        { name: "updated_at", docs: ["Last update timestamp."], type: "i64" },
        { name: "bump", docs: ["PDA bump."], type: "u8" },
        { name: "_reserved", docs: ["Reserved for future metadata extensions."], type: { array: ["u8", 7] } },
      ],
    },
  },
] as const;

const TASK_VALIDATION_V2_TYPES = [
  {
    name: "TaskValidationConfig",
    docs: [
      "Task-level validation configuration.",
      'PDA seeds: ["task_validation", task]',
    ],
    type: {
      kind: "struct",
      fields: [
        { name: "task", docs: ["Task this config belongs to."], type: "pubkey" },
        {
          name: "creator",
          docs: ["Task creator / reviewer authority."],
          type: "pubkey",
        },
        {
          name: "mode",
          docs: ["Active validation mode."],
          type: { defined: { name: "ValidationMode" } },
        },
        {
          name: "review_window_secs",
          docs: [
            "Review window in seconds before the submission may be escalated off-path.",
          ],
          type: "i64",
        },
        { name: "created_at", docs: ["Creation timestamp."], type: "i64" },
        { name: "updated_at", docs: ["Last update timestamp."], type: "i64" },
        { name: "bump", docs: ["PDA bump."], type: "u8" },
        {
          name: "_reserved",
          docs: ["Reserved for future validation variants."],
          type: { array: ["u8", 7] },
        },
      ],
    },
  },
  {
    name: "TaskSubmission",
    docs: [
      "Claim-level submission state for manual validation.",
      'PDA seeds: ["task_submission", claim]',
    ],
    type: {
      kind: "struct",
      fields: [
        { name: "task", docs: ["Task being submitted."], type: "pubkey" },
        { name: "claim", docs: ["Claim tied to this submission."], type: "pubkey" },
        { name: "worker", docs: ["Worker that submitted the result."], type: "pubkey" },
        {
          name: "status",
          docs: ["Current submission status."],
          type: { defined: { name: "SubmissionStatus" } },
        },
        {
          name: "proof_hash",
          docs: ["Latest proof hash supplied by the worker."],
          type: { array: ["u8", 32] },
        },
        {
          name: "result_data",
          docs: ["Latest result payload supplied by the worker."],
          type: { array: ["u8", 64] },
        },
        {
          name: "submission_count",
          docs: ["Number of times this claim has been submitted for review."],
          type: "u16",
        },
        {
          name: "submitted_at",
          docs: ["Timestamp of latest submission."],
          type: "i64",
        },
        {
          name: "review_deadline_at",
          docs: ["Timestamp after which the review window has elapsed."],
          type: "i64",
        },
        {
          name: "accepted_at",
          docs: ["Acceptance timestamp (0 when unresolved)."],
          type: "i64",
        },
        {
          name: "rejected_at",
          docs: ["Rejection timestamp (0 when unresolved)."],
          type: "i64",
        },
        {
          name: "rejection_hash",
          docs: ["Optional rejection reason hash."],
          type: { array: ["u8", 32] },
        },
        { name: "bump", docs: ["PDA bump."], type: "u8" },
        {
          name: "_reserved",
          docs: ["Reserved for future attestation metadata."],
          type: { array: ["u8", 5] },
        },
      ],
    },
  },
  {
    name: "TaskAttestorConfig",
    docs: [
      "Task-level external attestor configuration.",
      'PDA seeds: ["task_attestor", task]',
    ],
    type: {
      kind: "struct",
      fields: [
        { name: "task", docs: ["Task this config belongs to."], type: "pubkey" },
        {
          name: "creator",
          docs: ["Task creator / reviewer authority."],
          type: "pubkey",
        },
        {
          name: "attestor",
          docs: ["Wallet allowed to attest the outcome."],
          type: "pubkey",
        },
        { name: "created_at", docs: ["Creation timestamp."], type: "i64" },
        { name: "updated_at", docs: ["Last update timestamp."], type: "i64" },
        { name: "bump", docs: ["PDA bump."], type: "u8" },
        {
          name: "_reserved",
          docs: ["Reserved for future attestor metadata."],
          type: { array: ["u8", 7] },
        },
      ],
    },
  },
  {
    name: "TaskValidationVote",
    docs: [
      "Reviewer vote or attestation recorded for a task submission round.",
      'PDA seeds: ["task_validation_vote", task_submission, reviewer]',
    ],
    type: {
      kind: "struct",
      fields: [
        {
          name: "submission",
          docs: ["Submission being validated."],
          type: "pubkey",
        },
        {
          name: "reviewer",
          docs: ["Reviewer wallet that cast the vote / attestation."],
          type: "pubkey",
        },
        {
          name: "reviewer_agent",
          docs: [
            "Reviewer agent used for validator-quorum mode (default pubkey for attestors).",
          ],
          type: "pubkey",
        },
        {
          name: "submission_round",
          docs: ["Submission round the vote applies to."],
          type: "u16",
        },
        {
          name: "approved",
          docs: ["Whether the reviewer approved the result."],
          type: "bool",
        },
        {
          name: "voted_at",
          docs: ["Timestamp of the vote / attestation."],
          type: "i64",
        },
        { name: "bump", docs: ["PDA bump."], type: "u8" },
        {
          name: "_reserved",
          docs: ["Reserved for future metadata."],
          type: { array: ["u8", 5] },
        },
      ],
    },
  },
  {
    name: "ValidationMode",
    docs: ["Validation mode configured for a task."],
    repr: { kind: "rust" },
    type: {
      kind: "enum",
      variants: [
        { name: "Auto" },
        { name: "CreatorReview" },
        { name: "ValidatorQuorum" },
        { name: "ExternalAttestation" },
      ],
    },
  },
  {
    name: "SubmissionStatus",
    docs: ["Task submission lifecycle for manual validation."],
    repr: { kind: "rust" },
    type: {
      kind: "enum",
      variants: [
        { name: "Idle" },
        { name: "Submitted" },
        { name: "Accepted" },
        { name: "Rejected" },
      ],
    },
  },
] as const;

function mergeIdlEntries<T extends NamedIdlEntry>(
  existing: readonly T[] | undefined,
  extras: readonly T[],
): T[] {
  const merged = new Map<string, T>();

  for (const entry of existing ?? []) {
    merged.set(entry.name, entry);
  }
  for (const entry of extras) {
    if (!merged.has(entry.name)) {
      merged.set(entry.name, entry);
    }
  }

  return Array.from(merged.values());
}

function overrideInstructionAccounts(
  existing: readonly NamedIdlInstruction[] | undefined,
  mode: ProgramLayoutMode = "default",
): NamedIdlInstruction[] {
  return (existing ?? []).map((instruction) => {
    const override =
      mode === "legacyInitiateDispute" &&
      instruction.name === "initiate_dispute"
        ? LEGACY_INITIATE_DISPUTE_ACCOUNT_LAYOUT
        : mode === "legacyCreateTask" && instruction.name === "create_task"
          ? LEGACY_CREATE_TASK_ACCOUNT_LAYOUT
          : MARKETPLACE_ACCOUNT_LAYOUT_OVERRIDES[
              instruction.name as keyof typeof MARKETPLACE_ACCOUNT_LAYOUT_OVERRIDES
            ];
    if (!override) {
      return instruction;
    }
    return {
      ...instruction,
      accounts: override as unknown as NamedIdlInstruction["accounts"],
    };
  });
}

function augmentIdl(
  baseIdl: Idl,
  mode: ProgramLayoutMode = "default",
): Idl {
  return {
    ...baseIdl,
    instructions: mergeIdlEntries(
      mergeIdlEntries(
        overrideInstructionAccounts(
          baseIdl.instructions as NamedIdlInstruction[] | undefined,
          mode,
        ) as unknown as NamedIdlEntry[],
        TASK_VALIDATION_V2_INSTRUCTIONS as unknown as NamedIdlEntry[],
      ),
      TASK_JOB_SPEC_INSTRUCTIONS as unknown as NamedIdlEntry[],
    ) as Idl["instructions"],
    accounts: mergeIdlEntries(
      mergeIdlEntries(
        baseIdl.accounts as NamedIdlEntry[] | undefined,
        TASK_VALIDATION_V2_ACCOUNTS as unknown as NamedIdlEntry[],
      ),
      TASK_JOB_SPEC_ACCOUNTS as unknown as NamedIdlEntry[],
    ) as Idl["accounts"],
    types: mergeIdlEntries(
      mergeIdlEntries(
        baseIdl.types as NamedIdlEntry[] | undefined,
        TASK_VALIDATION_V2_TYPES as unknown as NamedIdlEntry[],
      ),
      TASK_JOB_SPEC_TYPES as unknown as NamedIdlEntry[],
    ) as Idl["types"],
  };
}

/**
 * The AgenC Coordination program IDL.
 *
 * Typed as Anchor's generic `Idl` which correctly represents the snake_case
 * JSON structure. Use `Program<AgencCoordination>` for type-safe method access.
 */
export const IDL: Idl = {
  ...augmentIdl(AGENC_COORDINATION_IDL as Idl),
  address: PROGRAM_ID.toBase58(),
};

const LEGACY_INITIATE_DISPUTE_IDL: Idl = {
  ...augmentIdl(AGENC_COORDINATION_IDL as Idl, "legacyInitiateDispute"),
  address: PROGRAM_ID.toBase58(),
};

const LEGACY_CREATE_TASK_IDL: Idl = {
  ...augmentIdl(AGENC_COORDINATION_IDL as Idl, "legacyCreateTask"),
  address: PROGRAM_ID.toBase58(),
};

/**
 * Placeholder public key for read-only providers.
 * Uses a deterministic value derived from ones to avoid Keypair.generate() overhead.
 * This is never used for signing - only as a wallet identity placeholder.
 * Using fill(1) instead of fill(0) avoids PublicKey.default (system program at all zeros).
 */
const READ_ONLY_PLACEHOLDER_PUBKEY = new PublicKey(new Uint8Array(32).fill(1));

/**
 * Validates that an IDL has expected structure.
 * Throws a descriptive error if the IDL is malformed.
 *
 * @param idl - The IDL to validate (defaults to the imported IDL)
 * @throws Error if IDL is malformed (missing address or instructions)
 */
export function validateIdl(idl: Idl = IDL): void {
  if (!idl.address) {
    throw new Error(
      "IDL is missing program address. The published protocol artifact may be corrupted or outdated.",
    );
  }
  if (!idl.instructions || idl.instructions.length === 0) {
    throw new Error(
      "IDL has no instructions. The published protocol artifact may be corrupted or outdated.",
    );
  }
}

/**
 * Returns the IDL configured for a specific program ID.
 * If programId matches the default PROGRAM_ID, returns the original IDL.
 * Otherwise, returns a copy with the address field updated.
 *
 * @internal
 */
function getIdlForProgram(
  programId: PublicKey,
  mode: ProgramLayoutMode = "default",
): Idl {
  const baseIdl =
    mode === "legacyInitiateDispute"
      ? LEGACY_INITIATE_DISPUTE_IDL
      : mode === "legacyCreateTask"
        ? LEGACY_CREATE_TASK_IDL
        : IDL;
  if (programId.equals(PROGRAM_ID)) {
    return baseIdl;
  }
  // Create IDL copy with custom program address for local testing
  return { ...baseIdl, address: programId.toBase58() };
}

/**
 * Creates a read-only AnchorProvider that throws on signing attempts.
 * Uses a deterministic placeholder public key as the wallet identity.
 *
 * @internal
 */
function createReadOnlyProvider(connection: Connection): AnchorProvider {
  return new AnchorProvider(
    connection,
    {
      publicKey: READ_ONLY_PLACEHOLDER_PUBKEY,
      signTransaction: async () => {
        throw new Error(
          "Cannot sign with read-only program. Use createProgram() instead.",
        );
      },
      signAllTransactions: async () => {
        throw new Error(
          "Cannot sign with read-only program. Use createProgram() instead.",
        );
      },
    },
    { commitment: "confirmed" },
  );
}

/**
 * Creates a Program instance for transactions.
 *
 * @param provider - AnchorProvider with connection and wallet
 * @param programId - Optional custom program ID (defaults to PROGRAM_ID)
 * @returns Program instance configured for the specified program ID
 *
 * @example
 * ```typescript
 * const provider = new AnchorProvider(connection, wallet, {});
 * const program = createProgram(provider);
 * await program.methods.createTask(...).rpc();
 * ```
 */
export function createProgram(
  provider: AnchorProvider,
  programId: PublicKey = PROGRAM_ID,
  mode: ProgramLayoutMode = "default",
): Program<AgencCoordination> {
  validateIdl();
  // Cast to AgencCoordination for type-safe Program access
  // Anchor's Program class handles snake_case ↔ camelCase mapping internally
  return new Program<AgencCoordination>(
    getIdlForProgram(programId, mode) as AgencCoordination,
    provider,
  );
}

/**
 * Creates a read-only Program instance (no wallet required).
 * Use this for querying account data without signing transactions.
 *
 * @param connection - Solana RPC connection
 * @param programId - Optional custom program ID (defaults to PROGRAM_ID)
 * @returns Program instance that throws on any signing attempt
 *
 * @example
 * ```typescript
 * const connection = new Connection('https://api.devnet.solana.com');
 * const program = createReadOnlyProgram(connection);
 * const task = await program.account.task.fetch(taskPda);
 * ```
 */
export function createReadOnlyProgram(
  connection: Connection,
  programId: PublicKey = PROGRAM_ID,
  mode: ProgramLayoutMode = "default",
): Program<AgencCoordination> {
  validateIdl();
  // Cast to AgencCoordination for type-safe Program access
  // Anchor's Program class handles snake_case ↔ camelCase mapping internally
  return new Program<AgencCoordination>(
    getIdlForProgram(programId, mode) as AgencCoordination,
    createReadOnlyProvider(connection),
  );
}
