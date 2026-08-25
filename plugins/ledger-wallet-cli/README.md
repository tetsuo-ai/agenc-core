# ledger-wallet-cli

Optional AgenC integration for Ledger's official `@ledgerhq/wallet-cli` 1.0.2
contract. The plugin contributes the Wallet CLI Harness skill, its strict JSON
scripts, and a local stdio MCP wrapper; it does not add brand-specific commands
or UI to AgenC core.

```bash
agenc plugin install ./plugins/ledger-wallet-cli --scope user
```

Put the official `wallet-cli` binary on `PATH` before starting AgenC. Both MCP
tools invoke the packaged Python scripts without a shell. The scripts validate
known flags, force `--output json`, and decide success from the final JSON
object instead of the process exit code.

The MCP surface mirrors these supported entry points:

```bash
python3 scripts/wallet_cli_harness.py -- session view
python3 scripts/wallet_cli_workflow.py balance-all
```

Live sends remain dry-run first and require explicit human approval before the
same validated command is rerun without `--dry-run`.

## Core boundary

This plugin is the only Ledger-specific integration shipped in the repository.
Core contains no branded Android handoff, transfer tool, capability route, or
receipt protocol. Wallet operations run through the plugin's strict wrapper
around the official CLI after explicit installation and invocation.
