---
name: wallet-cli-harness
description: "Route Codex requests to the official standalone @ledgerhq/wallet-cli contract for bitcoin, ethereum, and solana wallet flows: account discover, session view/reset, balances, operations, receive, send with dry-run and approval, swap quote/execute/status, genuine-check, and asset lookup. Includes a wallet-cli-only decision tree and JSON harness."
---

# Wallet CLI Harness

Independent Codex operating instructions for the official standalone `@ledgerhq/wallet-cli` package. This plugin is not affiliated with, endorsed by, or sponsored by Ledger.

Installed command:

```bash
wallet-cli <command> [flags] --output json
```

Supported top-level wallet-cli areas: session labels, account discovery, balances, operations, receive addresses, sends, swaps, token metadata, and genuine checks.

This targets the official 1.0.2 command contract. Decide success from the final JSON object, not from the process exit code. The harness exists because the published CLI can accept unknown flags without failing.

## Wallet-CLI-Only Routing

When this plugin is active, stay on the official `wallet-cli` path.

Allowed command surfaces:

- `python3 <plugin-root>/scripts/wallet_cli_workflow.py ...`
- `python3 <plugin-root>/scripts/wallet_cli_harness.py -- ...`
- `wallet-cli ... --help` when raw official help text is needed

Do not use local secret-store files, operating-system hardware scans, direct blockchain endpoint queries, remembered balances, previous screenshots, or unrelated wallet tools for wallet balance, discovery, history, receive, send, swap, token, or genuine-check requests.

If the user says a device is connected by cable during a wallet-cli flow, continue with the requested wallet-cli action. Do not pivot into host diagnosis unless the user explicitly asks for a general computer hardware inventory.

Resolve `<plugin-root>` as the plugin directory containing `skills/`. In
an AgenC source checkout, that is the containing `plugins/ledger-wallet-cli`
directory; after installation it is the installed plugin root.

The optional MCP server exposes the same two scripts as tools. Using those MCP
tools is equivalent to invoking the commands below; it does not broaden the
wallet-cli command or flag allowlist.

## First Response Style

First impressions matter. When the user asks what this plugin can do, how it works, or says they are using `wallet-cli-harness`, open with a capability presentation, then ask what to run.

| Capability | What I can run | Typical command |
| --- | --- | --- |
| Session labels | Show or reset saved wallet-cli accounts | `session view`, `session reset` |
| Balances | Check every saved label or one saved label | `balance-all`, `balances <label>` |
| Account discovery | Discover accounts for a network | `account discover <network>` |
| History | Show recent operations for an account | `operations <label> --limit 20` |
| Receive | Generate or verify receive addresses | `receive <label>`, `receive <label> --no-verify` |
| Send | Dry-run, summarize, then execute after approval | `send <label> --to <addr> --amount '<n> TICKER'` |
| Swap | Quote, execute, and check swap status | `swap quote`, `swap execute`, `swap status` |
| Assets | Resolve token metadata | `assets token`, `assets token-by-id` |
| Device check | Run a bounded official genuine check | `device-check` |

Ask only for missing inputs needed for the requested action, such as network, account label, recipient, amount, ticker, provider, or swap id.

## Decision Tree

Follow this tree for every user message while the plugin is active.

1. **Capability request**
   If the user asks what the plugin can do, show the capability table above and ask what to run.

2. **Balance or holdings**
   If the user asks for wallet balance, balances, holdings, funds, total, "my wallet", "what do I have", or similar, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_workflow.py balance-all
   ```

   Summarize nonzero balances first, then zero labels. Mention how many saved labels were checked. Do not inspect any other wallet source.

3. **Account discovery, connected wallet, wallet device, scan, import, or accounts**
   Route to wallet-cli account discovery. Required input: network.

   If network is missing, ask exactly:

   ```text
   Which network should I scan: bitcoin, ethereum, or solana?
   ```

   If network is present, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_workflow.py discover --network <network>
   ```

   Report discovered labels and addresses from the final JSON object. If wallet-cli returns an error, report that wallet-cli result and ask whether to retry or adjust inputs.

4. **Session labels**
   If the user asks for saved accounts, labels, or session state, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_harness.py -- session view
   ```

5. **History or activity**
   Required input: account label.

   If label is missing, run `session view`, show available labels, and ask which label to inspect. If label is present, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_harness.py -- operations <label> --limit 20
   ```

6. **Receive or deposit address**
   Required input: account label.

   If label is missing, run `session view`, show labels, and ask which label. If the user asks for verified receive, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_harness.py -- receive <label>
   ```

   If the user asks for a quick address without device verification, run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_harness.py -- receive <label> --no-verify
   ```

7. **Send, transfer, pay, withdraw, or move funds**
   Required inputs: account label, recipient, amount with ticker.

   If any are missing, ask only for the missing values. First run a dry-run:

   ```bash
   python3 <plugin-root>/scripts/wallet_cli_harness.py -- send <label> --to <recipient> --amount '<amount TICKER>' --dry-run
   ```

   Summarize recipient, amount, and fee from the final JSON object. Ask for explicit approval before live send. After approval, run the same command without `--dry-run`.

8. **Swap, convert, trade, quote, or swap status**
   For quotes, collect from asset, to asset, amount, and source/destination account or fresh-address flags, then run `swap quote`.

   For execute, collect provider, from, to, amount, account, to-account, and fee strategy if needed, then run `swap execute`.

   For status, collect swap id and provider, then run `swap status`.

9. **Token metadata**
   If the user provides a token address plus network, run `assets token <network> <address>`. If they provide a token id, run `assets token-by-id <id>`. Ask for the missing network/address/id only if needed.

10. **Device check, Ledger check, genuine check, or authenticity**
    Run:

    ```bash
    python3 <plugin-root>/scripts/wallet_cli_workflow.py device-check
    ```

    This workflow is bounded: it passes `--device-timeout 10000` to wallet-cli and also applies a 15 second process timeout. If it times out or returns no final JSON object, report that exact JSON result and stop. Do not keep waiting, start another wallet-cli device command, or switch to a hardware inventory scan.

11. **Reset or start over**
    Run:

    ```bash
    python3 <plugin-root>/scripts/wallet_cli_harness.py -- session reset
    ```

12. **Ambiguous request**
    Ask one routing question tied to wallet-cli capabilities. Do not provide a generic computer inventory or host diagnosis.

## Response Examples

For `check the balance of my wallet`:

```text
I will read saved wallet-cli labels with session view, then check balances for each saved label through wallet-cli.
```

For `discover accounts` with no network:

```text
I can discover wallet-cli accounts. Which network should I scan: bitcoin, ethereum, or solana?
```

For `find my wallet devices` or `list wallet devices`:

```text
I can run wallet-cli account discovery next. Which network should I scan: bitcoin, ethereum, or solana?
```

For `the device is connected by cable` during a wallet-cli flow:

```text
Got it. I will continue with the wallet-cli command path. Which wallet-cli action should I run: discover accounts, check balances, receive, send, history, or genuine check?
```

## Plugin Scripts

Prefer the workflow script for common informal requests:

```bash
python3 <plugin-root>/scripts/wallet_cli_workflow.py balance-all
python3 <plugin-root>/scripts/wallet_cli_workflow.py discover --network solana
python3 <plugin-root>/scripts/wallet_cli_workflow.py device-check
```

Use the lower-level harness for direct wallet-cli commands:

```bash
python3 <plugin-root>/scripts/wallet_cli_harness.py -- session view
python3 <plugin-root>/scripts/wallet_cli_harness.py -- balances ethereum-1
python3 <plugin-root>/scripts/wallet_cli_harness.py -- send ethereum-1 --to 0xRECIPIENT --amount '0.01 ETH' --dry-run
```

The harness:

- validates flags for the selected official command before launch;
- appends `--output json` when missing;
- parses the final JSON object from stdout and reports `walletCliExitCode` separately;
- preserves the wallet-cli command surface instead of substituting any other wallet tool.

For `wallet-cli <command> --help`, call the binary directly or pass `--no-auto-output-json` to the harness. If a new wallet-cli release adds a flag before this plugin is updated, update the harness allowlist before using that flag.

## Output Contract

Always pass `--output json` when parsing. In JSON mode stdout is NDJSON: zero or more intermediate events, then one final object.

Decide the outcome from the final JSON object, not from the exit code. The official binary may exit `0` even on command errors. Dispatch in this order, per line:

1. `{"type":"device-state", ...}` - non-terminal device progress. Relay `message` to the human and keep waiting.
2. `{"type":"pre-verify-address", "address": ...}` - emitted by `receive` before on-device confirmation. Show the address so the human can compare it to the device screen.
3. `{"status":"success", "command": ..., ...data, "timestamp": ...}` - success. Read the per-command data keys.
4. `{"ok":false, "error":{"command": ..., "message": ...}}` - command failed. There is only `message`; do not invent structured error fields.
5. `{"ok":false, "error":{"kind": "command-not-found"|"validation", "available":[...]?, ...}}` - framework error, usually a bad command or malformed value. Fix the invocation.

Success keys on `status`; errors key on `ok`. Help/version in agent mode come back as `{"ok":true,"data":{"type":"help"|"version", ...}}`. Amounts in JSON are formatted strings with ticker, for example `"0.5 ETH"`.

## Critical Safety: Unknown Flags

The official CLI does not reliably fail on unknown flags. A typo or invented flag can be ignored while the command proceeds.

- Never invent or guess a flag. Verify flags against this skill or `wallet-cli <command> --help`.
- A botched `--dry-run` can turn a send into a live action. After any dry-run, confirm the success object proves it was a dry-run and shows no broadcast or transaction hash.

## Money Movement Rails

1. Dry-run first, verify the echo. Before any live `send`, run the byte-identical command with `--dry-run --output json`, confirm recipient, amount, fee, and no broadcast, show that to the human, get explicit approval, then re-run without `--dry-run`.
2. One device command at a time. Never run two device-touching commands concurrently across sessions or terminals.
3. Never kill a command waiting on the device. Let it time out by itself.
4. Never auto-retry a rejection. Ask whether to retry or abort.
5. After any ambiguous failure following a sign prompt, run `operations <account>` or `swap status` before re-sending.
6. `receive --no-verify` is unverified by the trusted display. Prefer plain `receive` when the user needs a trusted-display address.
7. Ambiguous request means ask. Missing recipient, network, ticker, account label, or amount should stop the action until clarified.

## Sessions And Labels

`account discover` saves discovered accounts to a local wallet-cli session under labels like `ethereum-1` or `solana-3`. Commands that take an account should use a session label. Run `session view` to list labels.

- `session view` returns `{accounts:[{label, descriptor}]}`.
- `session reset` clears the wallet-cli session store.

## Commands

| Command | Device interaction | Key flags |
| --- | --- | --- |
| `session view` / `session reset` | No | `--output` |
| `balances` | No | `--account/-a`, `--output` |
| `operations` | No | `--account/-a`, `--limit/-l`, `--cursor`, `--output` |
| `assets token` / `assets token-by-id` | No | positional `<network> <addr>` / `<id>`, `--output` |
| `swap quote` | No | `--from/-f`, `--to/-t`, `--amount`, `--from-account`/`--from-fresh-address`, `--to-account`/`--to-fresh-address`, `--output` |
| `swap status` | No | `--swap-id`, `--provider`, `--output` |
| `send --dry-run` | No | same as `send`, plus `--dry-run` |
| `account discover` | Yes | `--network/-n`, `--output`, `--device-timeout` |
| `receive` | Yes by default | `--account/-a`, `--verify/-v`, `--no-verify`, `--output`, `--device-timeout` |
| `send` live | Yes | `--account/-a`, `--to/-t`, `--amount`, `--fee-per-byte`, `--rbf`, `--mode`, `--validator`, `--stake-account`, `--memo`, `--data`, `--dry-run`, `--output`, `--device-timeout` |
| `genuine-check` | Yes | Use `wallet_cli_workflow.py device-check` for bounded execution; raw flags are `--output`, `--device-timeout` |
| `swap execute` | Yes | `--from/-f`, `--to/-t`, `--provider`, `--amount`, `--account/-a`, `--to-account`, `--fee-strategy`, `--output` |

Notes:

- `send --amount` must include a ticker, such as `'0.001 BTC'`, `'0.01 ETH'`, or `'100 USDT'`.
- There is no `--token` flag; the ticker drives asset resolution.
- `--data` is EVM calldata. Make the human explain and confirm it before signing.
- `swap execute` has no dry-run. Brief the human first and use `swap status --swap-id <id> --provider <provider>` to monitor or recover.

## Intent Map

| User says | Command path |
| --- | --- |
| "check my wallet balance", "what do I have", "holdings" | `wallet_cli_workflow.py balance-all` |
| "show saved accounts", "labels" | `session view` |
| "find/scan/import my accounts", "wallet device" | `account discover <network>` |
| "my address", "where do I deposit" | `receive <account>` or `receive <account> --no-verify` |
| "balance for ethereum-1" | `balances ethereum-1` |
| "history", "what did I send" | `operations <account>` |
| "send/transfer/pay X to Y" | dry-run `send`, summarize, ask approval, then live `send` |
| "swap/convert/trade A to B" | `swap quote`, then `swap execute`, then `swap status` |
| "check my Ledger device", "is this Ledger genuine" | `wallet_cli_workflow.py device-check` |
| "what is this token" | `assets token <network> <addr>` or `assets token-by-id <id>` |
| "start over / clear session" | `session reset` |

## AgenC Core Boundary

All Ledger-specific behavior is confined to this optional plugin. AgenC Core
does not provide a branded Android handoff, model-facing transfer tool,
capability route, or receipt protocol. Use only the official CLI workflows
documented here after the plugin has been explicitly installed.
