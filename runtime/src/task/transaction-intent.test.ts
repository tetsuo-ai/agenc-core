import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";

import { buildCreateTaskIntent } from "./transaction-intent.js";
import { PROGRAM_ID } from "@tetsuo-ai/sdk";

describe("marketplace transaction intent builders", () => {
  it("builds a normalized create-task intent before signing", () => {
    const signer = Keypair.generate().publicKey;
    const creatorAgentPda = Keypair.generate().publicKey;
    const taskId = new Uint8Array(32).fill(0x11);
    const rewardMint = Keypair.generate().publicKey;

    const intent = buildCreateTaskIntent({
      programId: PROGRAM_ID,
      signer,
      creatorAgentPda,
      taskId,
      rewardLamports: 123n,
      rewardMint,
      jobSpecHash: "a".repeat(64),
      constraintHash: new Uint8Array(32).fill(0xbb),
    });

    expect(intent.kind).toBe("create_task");
    expect(intent.programId).toBe(PROGRAM_ID.toBase58());
    expect(intent.signer).toBe(signer.toBase58());
    expect(intent.taskId).toBe("11".repeat(32));
    expect(intent.jobSpecHash).toBe("a".repeat(64));
    expect(intent.rewardLamports).toBe("123");
    expect(intent.rewardMint).toBe(rewardMint.toBase58());
    expect(intent.constraintHash).toBe("bb".repeat(32));
    expect(intent.accountMetas.map((account) => account.name)).toEqual(
      expect.arrayContaining([
        "task",
        "escrow",
        "creatorAgent",
        "protocolConfig",
        "authorityRateLimit",
        "creator",
        "systemProgram",
        "creatorTokenAccount",
        "tokenEscrowAta",
        "tokenProgram",
        "associatedTokenProgram",
      ]),
    );
    expect(intent.accountMetas.find((account) => account.name === "creator"))
      .toMatchObject({
        pubkey: signer.toBase58(),
        isSigner: true,
        isWritable: true,
      });
  });

  it("rejects malformed task ids before creating an intent", () => {
    expect(() =>
      buildCreateTaskIntent({
        programId: PROGRAM_ID,
        signer: Keypair.generate().publicKey,
        creatorAgentPda: Keypair.generate().publicKey,
        taskId: new Uint8Array(31),
        rewardLamports: 123n,
      }),
    ).toThrow(/taskId/);
  });
});
