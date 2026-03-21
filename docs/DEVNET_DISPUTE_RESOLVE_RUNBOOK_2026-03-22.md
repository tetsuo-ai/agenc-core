# Devnet Dispute Resolve Runbook

Resolve dispute `J3RczLeMm9euKP2pgMRQQmS2x4G9vbsjfHgXhtL8yPTb` after the voting deadline.

## When

- Earliest valid time: `2026-03-22 18:00:43 UTC`
- Berlin local time: `2026-03-22 19:00:43 CET`

## Required signer

- Protocol authority pubkey: `E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg`
- Local keypair path: `/Users/pchmirenko/.config/solana/id.json`

## Why the temp HOME matters

The default CLI path under the real home loads `/Users/pchmirenko/.agenc/config.json`, which currently fails validation. Using a clean `HOME` avoids that unrelated gateway config parse error.

## One-time prep

```bash
mkdir -p /tmp/agenc-rehearsal.V2n5jI/protocol-home/.config/solana
cp /Users/pchmirenko/.config/solana/id.json /tmp/agenc-rehearsal.V2n5jI/protocol-home/.config/solana/id.json
```

## Optional preflight

```bash
date -u
solana-keygen pubkey /tmp/agenc-rehearsal.V2n5jI/protocol-home/.config/solana/id.json
```

Expected pubkey:

```text
E9ws2V2vuv53HXRh8ydX5PRGAiCsg2QTmsTZAu145Frg
```

## Resolve command

Run only after the deadline above:

```bash
HOME=/tmp/agenc-rehearsal.V2n5jI/protocol-home \
node /Users/pchmirenko/agenc-core-marketplace-smoke/runtime/dist/bin/agenc.js \
market disputes resolve J3RczLeMm9euKP2pgMRQQmS2x4G9vbsjfHgXhtL8yPTb \
--rpc https://api.devnet.solana.com \
--arbiter-votes \
227vKVDiLfgbfU4M5NyAbYkaj1ZQuvHucMCj9kBVCEKQ:6Xyzv26T1yXmRE2Lu7z5t7fqCVugRbKbYqhxSK4sZ3VS,83fbkmnzNaQ2JRCTQpLLKjmAr5tKpB6YzxkM4vkwouyu:W5pgb8rLpBotHpuCeYbecY9GcWa9hRZiGEeCzrWQCDi,E5UozmTqAuit61j3EX6XW7ebBE8oMq63nWWtpumas2kg:4nL15uX9WbufXkpKLM7VD5ZwuixfBZm3g7XuoZthhEoe \
--output json
```

## Vote pairs

- `227vKVDiLfgbfU4M5NyAbYkaj1ZQuvHucMCj9kBVCEKQ` -> `6Xyzv26T1yXmRE2Lu7z5t7fqCVugRbKbYqhxSK4sZ3VS`
- `83fbkmnzNaQ2JRCTQpLLKjmAr5tKpB6YzxkM4vkwouyu` -> `W5pgb8rLpBotHpuCeYbecY9GcWa9hRZiGEeCzrWQCDi`
- `E5UozmTqAuit61j3EX6XW7ebBE8oMq63nWWtpumas2kg` -> `4nL15uX9WbufXkpKLM7VD5ZwuixfBZm3g7XuoZthhEoe`

## Known good validation

Before the deadline, the same command with the correct protocol authority fails with:

```text
Voting period has not ended
```

That confirms signer/auth is correct and the remaining gate is only time.
