# AgenC Mainnet Deployment Checklist

## Private Verification Gate (RISC0 Router Model)

Before mainnet deployment, private completion must use only the router-verification path.

### Required private payload shape

- `sealBytes` (260 bytes)
- `journal` (192 bytes)
- `imageId` (32 bytes, trusted)
- `bindingSeed` (32 bytes)
- `nullifierSeed` (32 bytes)

### Required private verification accounts

- `routerProgram`
- `router`
- `verifierEntry`
- `verifierProgram`
- `bindingSpend`
- `nullifierSpend`

## Pre-Deploy Gates (mandatory)

### Readiness check

**Prerequisites**
- [ ] Node toolchain installed
- [ ] Dependencies installed

**Steps**
1. Run:
   ```bash
   # check-deployment-readiness.sh has been removed (see cleanup/dead-code-audit).
   # Use npm run validate:runtime as the primary pre-deploy readiness gate.
   npm run validate:runtime
   ```

**Expected Output**
```
All checks PASS
```

**Minimum checks that must pass**
- Trusted router program ID matches deployment config
- Trusted verifier program ID matches deployment config
- Trusted selector is pinned and active in verifier entry PDA
- Trusted image ID matches guest deployment
- `sealBytes` envelope size is enforced (260 bytes)
- Journal fixed length is enforced (192 bytes)
- `bindingSpend` and `nullifierSpend` replay accounts are enabled

### Test + mutation gates

**Prerequisites**
- [ ] Node toolchain installed
- [ ] Dependencies installed

**Steps**
1. Run the default required runtime validation lane from the `agenc-core` root:
   ```bash
   npm run validate:runtime
   ```

This is the same runtime gate lane enforced by the default PR validation workflows.

**Runtime gates included in `npm run validate:runtime`**
- Runtime unit/regression suite (`npm --prefix runtime run test`)
- Runtime mutation artifact + gate evaluation
- Runtime pipeline quality artifact + gate evaluation
- Runtime delegation quality artifact + gate evaluation
- Runtime background-run quality artifact + gate evaluation
- Runtime autonomy rollout gates

**Optional deeper local checks**
- LiteSVM fast integration suite:
  ```bash
  npm run test:fast
  ```

### Build artifact verification (verifiable build)

**Prerequisites**
- [ ] Anchor toolchain installed (Anchor 0.32.1, Solana 3.0.13)
- [ ] solana-verify installed

**Steps**
1. Build verifiable program:
   ```bash
   anchor build --verifiable
   ```
2. Record executable hash:
   ```bash
   solana-verify get-executable-hash target/deploy/agenc_coordination.so
   ```

## Runtime/SDK private flow checks

- [ ] SDK submission uses `completeTaskPrivate(..., { sealBytes, journal, imageId, bindingSeed, nullifierSeed })`
- [ ] Runtime completion path passes router/verifier-entry accounts
- [ ] Replay failure is observed when either `bindingSpend` or `nullifierSpend` already exists
- [ ] Trusted-selector mismatch and trusted-image mismatch fail closed
- [ ] Pipeline quality artifact (`runtime/benchmarks/artifacts/pipeline-quality.ci.json`) is generated and reviewed
- [ ] Background-run quality artifact (`runtime/benchmarks/artifacts/background-run-quality.ci.json`) is generated and reviewed
- [ ] Pipeline gates report `PASS` for context growth, tool-turn forwarding, desktop timeout regressions, and token-efficiency thresholds
- [ ] Background-run gates and autonomy rollout gates report `PASS`

## Rollback plan

If any private verification gate fails:

1. Stop deployment.
2. Keep protocol on current release.
3. Patch config/code and rerun:
   - `anchor build`
   - `npm --prefix sdk test`
   - `npm run validate:runtime`
4. Resume deployment only after all checks pass.
