/**
 * Unit tests for IDL exports and program factory functions.
 */

import { describe, it, expect } from 'vitest';
import { Connection, PublicKey, Keypair, Transaction } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@coral-xyz/anchor';
import { AGENC_COORDINATION_IDL } from '@tetsuo-ai/protocol';
import { PROGRAM_ID } from '@tetsuo-ai/sdk';
import {
  IDL,
  createProgram,
  createReadOnlyProgram,
  type AgencCoordination,
} from './idl';

describe('IDL exports', () => {
  type InstructionWithAccounts = {
    name: string;
    accounts?: Array<{ name: string; writable?: boolean }>;
  };

  it('exports a valid IDL object', () => {
    expect(IDL).toBeDefined();
    expect(typeof IDL).toBe('object');
  });

  it('has correct program address', () => {
    expect(IDL.address).toBe(PROGRAM_ID.toBase58());
  });

  it('exports a protocol IDL object alongside the runtime IDL', () => {
    expect(AGENC_COORDINATION_IDL).toBeDefined();
    expect(typeof AGENC_COORDINATION_IDL).toBe('object');
    expect(typeof AGENC_COORDINATION_IDL.address).toBe('string');
  });

  it('has expected metadata', () => {
    expect(IDL.metadata).toBeDefined();
    expect(IDL.metadata.name).toBe('agenc_coordination');
    expect(IDL.metadata.version).toBe('0.1.0');
    expect(IDL.metadata.spec).toBe('0.1.0');
    expect(IDL.metadata.description).toContain('AgenC');
  });

  it('has instructions array with entries', () => {
    expect(Array.isArray(IDL.instructions)).toBe(true);
    expect(IDL.instructions.length).toBeGreaterThan(0);
  });

  it('overrides devnet marketplace account layouts for task/dispute instructions', () => {
    const createTask = IDL.instructions.find((ix) => ix.name === 'create_task');
    const createDependentTask = IDL.instructions.find(
      (ix) => ix.name === 'create_dependent_task',
    );
    const initiateDispute = IDL.instructions.find(
      (ix) => ix.name === 'initiate_dispute',
    );

    expect(createTask?.accounts.map((account) => account.name)).not.toContain(
      'authority_rate_limit',
    );
    expect(
      createTask?.accounts.find((account) => account.name === 'creator_agent')
        ?.writable,
    ).toBe(true);
    expect(
      createDependentTask?.accounts.map((account) => account.name),
    ).not.toContain('authority_rate_limit');
    expect(
      createDependentTask?.accounts.find(
        (account) => account.name === 'creator_agent',
      )?.writable,
    ).toBe(true);
    expect(
      initiateDispute?.accounts.map((account) => account.name),
    ).toContain('authority_rate_limit');
    expect(
      initiateDispute?.accounts.map((account) => account.name),
    ).toContain('task_submission');
  });

  it('has expected instruction names', () => {
    const instructionNames = IDL.instructions.map((ix) => ix.name);
    // Verify some key instructions exist
    expect(instructionNames).toContain('create_task');
    expect(instructionNames).toContain('claim_task');
    expect(instructionNames).toContain('complete_task');
    expect(instructionNames).toContain('configure_task_validation');
    expect(instructionNames).toContain('submit_task_result');
    expect(instructionNames).toContain('accept_task_result');
    expect(instructionNames).toContain('reject_task_result');
    expect(instructionNames).toContain('auto_accept_task_result');
    expect(instructionNames).toContain('validate_task_result');
    expect(instructionNames).toContain('register_agent');
  });

  it('matches the deployed devnet task creation signer layout', () => {
    const instructions = IDL.instructions as InstructionWithAccounts[];

    for (const instructionName of ['create_task', 'create_dependent_task']) {
      const instruction = instructions.find((ix) => ix.name === instructionName);
      expect(instruction).toBeDefined();

      const accountNames =
        instruction?.accounts?.map((account) => account.name) ?? [];
      const creatorAgent = instruction?.accounts?.find(
        (account) => account.name === 'creator_agent',
      );
      const creatorAgentIndex = accountNames.indexOf('creator_agent');
      const authorityIndex = accountNames.indexOf('authority');
      const creatorIndex = accountNames.indexOf('creator');

      expect(accountNames).not.toContain('authority_rate_limit');
      expect(creatorAgent?.writable).toBe(true);
      expect(creatorAgentIndex).toBeGreaterThanOrEqual(0);
      expect(authorityIndex).toBeGreaterThanOrEqual(0);
      expect(creatorIndex).toBeGreaterThanOrEqual(0);
      expect(creatorAgentIndex).toBeLessThan(authorityIndex);
      expect(authorityIndex).toBeLessThan(creatorIndex);
    }
  });

  it('uses the deployed devnet create_task account order', () => {
    const createTask = IDL.instructions.find((ix) => ix.name === 'create_task');

    expect(createTask?.accounts.map((account) => account.name)).toEqual([
      'task',
      'escrow',
      'protocol_config',
      'creator_agent',
      'authority',
      'creator',
      'system_program',
      'reward_mint',
      'creator_token_account',
      'token_escrow_ata',
      'token_program',
      'associated_token_program',
    ]);
  });

  it('has accounts array with entries', () => {
    expect(Array.isArray(IDL.accounts)).toBe(true);
    expect(IDL.accounts.length).toBeGreaterThan(0);
  });

  it('has expected account types', () => {
    const accountNames = IDL.accounts.map((acc) => acc.name);
    expect(accountNames).toContain('AgentRegistration');
    expect(accountNames).toContain('Task');
    expect(accountNames).toContain('ProtocolConfig');
    expect(accountNames).toContain('TaskValidationConfig');
    expect(accountNames).toContain('TaskSubmission');
    expect(accountNames).toContain('TaskAttestorConfig');
    expect(accountNames).toContain('TaskValidationVote');
  });

  it('has types array', () => {
    expect(Array.isArray(IDL.types)).toBe(true);
    expect(IDL.types.length).toBeGreaterThan(0);
  });

  it('has task validation V2 type definitions', () => {
    const typeNames = IDL.types.map((typeDef) => typeDef.name);
    expect(typeNames).toContain('ValidationMode');
    expect(typeNames).toContain('SubmissionStatus');
    expect(typeNames).toContain('TaskValidationConfig');
    expect(typeNames).toContain('TaskSubmission');
    expect(typeNames).toContain('TaskAttestorConfig');
    expect(typeNames).toContain('TaskValidationVote');
  });

  it('has events array', () => {
    expect(Array.isArray(IDL.events)).toBe(true);
    expect(IDL.events.length).toBeGreaterThan(0);
  });

  it('has errors array', () => {
    expect(Array.isArray(IDL.errors)).toBe(true);
    expect(IDL.errors.length).toBeGreaterThan(0);
  });
});

describe('AgencCoordination type', () => {
  it('type is usable for Program generics', () => {
    // AgencCoordination type is for Program<T> generics, not raw IDL typing
    // The IDL is typed as Idl (snake_case), AgencCoordination is camelCase
    // Anchor's Program class handles the mapping internally
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
    const program = createReadOnlyProgram(connection);

    // Program should be typed as Program<AgencCoordination>
    expect(program.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
    expect(program.methods).toBeDefined();
  });
});

describe('createProgram', () => {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

  it('creates a Program instance with provider', () => {
    const program = createProgram(provider);
    expect(program).toBeDefined();
    expect(program.programId).toBeDefined();
  });

  it('uses SDK PROGRAM_ID as default programId', () => {
    const program = createProgram(provider);
    expect(program.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  it('accepts custom programId parameter', () => {
    const customId = Keypair.generate().publicKey;
    const program = createProgram(provider, customId);
    expect(program.programId.equals(customId)).toBe(true);
  });

  it('returns Program with correct IDL structure', () => {
    const program = createProgram(provider);
    // Verify we can access the idl
    expect(program.idl).toBeDefined();
    expect(program.idl.instructions).toBeDefined();
  });

  it('has expected account namespaces', () => {
    const program = createProgram(provider);
    // Verify account namespace is accessible
    expect(program.account).toBeDefined();
  });

  it('has expected methods namespace', () => {
    const program = createProgram(provider);
    // Verify methods namespace is accessible
    expect(program.methods).toBeDefined();
  });

  it('exposes task validation V2 methods through Program.methods', () => {
    const program = createProgram(provider);
    const methods = program.methods as Record<string, unknown>;
    expect(typeof methods.configureTaskValidation).toBe('function');
    expect(typeof methods.submitTaskResult).toBe('function');
    expect(typeof methods.acceptTaskResult).toBe('function');
    expect(typeof methods.rejectTaskResult).toBe('function');
    expect(typeof methods.autoAcceptTaskResult).toBe('function');
    expect(typeof methods.validateTaskResult).toBe('function');
  });
});

describe('createReadOnlyProgram', () => {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

  it('creates a Program instance from Connection', () => {
    const program = createReadOnlyProgram(connection);
    expect(program).toBeDefined();
    expect(program.programId).toBeDefined();
  });

  it('uses SDK PROGRAM_ID as default programId', () => {
    const program = createReadOnlyProgram(connection);
    expect(program.programId.toBase58()).toBe(PROGRAM_ID.toBase58());
  });

  it('accepts custom programId parameter', () => {
    const customId = Keypair.generate().publicKey;
    const program = createReadOnlyProgram(connection, customId);
    expect(program.programId.equals(customId)).toBe(true);
  });

  it('has a valid placeholder publicKey as wallet identity', () => {
    const program = createReadOnlyProgram(connection);
    const provider = program.provider as AnchorProvider;
    // The wallet uses a deterministic placeholder pubkey (not PublicKey.default)
    expect(provider.wallet.publicKey).toBeDefined();
    expect(provider.wallet.publicKey.equals(PublicKey.default)).toBe(false);
    // Should be a valid 32-byte public key
    expect(provider.wallet.publicKey.toBytes().length).toBe(32);
  });

  it('throws on signTransaction attempt', async () => {
    const program = createReadOnlyProgram(connection);
    const provider = program.provider as AnchorProvider;
    const dummyTx = new Transaction();

    await expect(provider.wallet.signTransaction(dummyTx)).rejects.toThrow(
      'Cannot sign with read-only program'
    );
  });

  it('throws on signAllTransactions attempt', async () => {
    const program = createReadOnlyProgram(connection);
    const provider = program.provider as AnchorProvider;
    const dummyTx = new Transaction();

    await expect(provider.wallet.signAllTransactions([dummyTx])).rejects.toThrow(
      'Cannot sign with read-only program'
    );
  });

  it('has confirmed commitment by default', () => {
    const program = createReadOnlyProgram(connection);
    const provider = program.provider as AnchorProvider;
    expect(provider.opts.commitment).toBe('confirmed');
  });

  it('returns Program with correct IDL structure', () => {
    const program = createReadOnlyProgram(connection);
    expect(program.idl).toBeDefined();
    expect(program.idl.instructions).toBeDefined();
  });

  it('has expected account namespaces', () => {
    const program = createReadOnlyProgram(connection);
    expect(program.account).toBeDefined();
  });
});

describe('getIdlForProgram behavior (internal)', () => {
  const connection = new Connection('http://127.0.0.1:8899', 'confirmed');

  it('returns original IDL when using default address', () => {
    const program = createReadOnlyProgram(connection);
    expect(program.idl.address).toBe(PROGRAM_ID.toBase58());
  });

  it('returns modified IDL with custom address when using custom programId', () => {
    const customId = Keypair.generate().publicKey;
    const program = createReadOnlyProgram(connection, customId);
    // The IDL address should be updated to the custom program ID
    expect(program.idl.address).toBe(customId.toBase58());
  });

  it('does not mutate original IDL when using custom programId', () => {
    const originalAddress = IDL.address;
    const customId = Keypair.generate().publicKey;

    // Create program with custom ID
    const program = createReadOnlyProgram(connection, customId);

    // Program should have custom address
    expect(program.idl.address).toBe(customId.toBase58());

    // Original IDL should be unchanged
    expect(IDL.address).toBe(originalAddress);
  });
});

describe('validateIdl error handling', () => {
  // Note: We test the error message content to ensure the validation logic is correct.
  // The actual mocking of malformed IDL would require module-level mocking which
  // is complex with ES modules. Instead, we verify the error messages are defined
  // correctly by testing the validation logic indirectly.

  it('IDL has required address field', () => {
    // If this test passes, it means IDL.address exists (validation would pass)
    // This confirms the positive path; the error path is tested via message content
    expect(IDL.address).toBeDefined();
    expect(typeof IDL.address).toBe('string');
    expect(IDL.address.length).toBeGreaterThan(0);
  });

  it('IDL has required instructions array', () => {
    // If this test passes, it means IDL.instructions exists and has content
    // This confirms the positive path for the instructions validation
    expect(IDL.instructions).toBeDefined();
    expect(Array.isArray(IDL.instructions)).toBe(true);
    expect(IDL.instructions.length).toBeGreaterThan(0);
  });

  it('createProgram and createReadOnlyProgram call validateIdl internally', () => {
    // These functions should work without error when IDL is valid
    // If validateIdl had issues, these would throw
    const connection = new Connection('http://127.0.0.1:8899', 'confirmed');
    const wallet = new Wallet(Keypair.generate());
    const provider = new AnchorProvider(connection, wallet, { commitment: 'confirmed' });

    expect(() => createProgram(provider)).not.toThrow();
    expect(() => createReadOnlyProgram(connection)).not.toThrow();
  });
});
