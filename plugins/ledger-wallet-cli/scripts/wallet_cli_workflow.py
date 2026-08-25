#!/usr/bin/env python3
"""Opinionated wallet-cli workflows for Codex.

These workflows deliberately stay inside the official wallet-cli command
surface through wallet_cli_harness.py. They give the LLM one clear command for
informal requests like "check my wallet balance" so it does not improvise with
unrelated local tools.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import re
import subprocess
import sys
from typing import Any


PLUGIN_ROOT = Path(__file__).resolve().parents[1]
HARNESS = PLUGIN_ROOT / "scripts" / "wallet_cli_harness.py"


def emit(payload: dict[str, Any], exit_code: int = 0) -> int:
    print(json.dumps(payload, indent=2, sort_keys=True))
    return exit_code


def text_or_empty(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def run_harness(args: list[str], timeout: int | None = None, process_timeout: int | None = None) -> dict[str, Any]:
    harness_args = [sys.executable, str(HARNESS)]
    if process_timeout is not None:
        harness_args.extend(["--timeout-seconds", str(process_timeout)])
    harness_args.extend(["--", *args])
    try:
        proc = subprocess.run(
            harness_args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired as exc:
        return {
            "ok": False,
            "command": ["wallet-cli", *args],
            "final": None,
            "stdout": text_or_empty(exc.stdout).strip(),
            "stderr": text_or_empty(exc.stderr).strip(),
            "workflowTimedOut": True,
            "timeoutSeconds": timeout,
            "workflowError": "workflow-subprocess-timeout",
        }

    try:
        payload = json.loads(proc.stdout)
    except json.JSONDecodeError:
        payload = {
            "ok": False,
            "command": ["wallet-cli", *args],
            "final": None,
            "stdout": proc.stdout,
            "stderr": proc.stderr.strip(),
            "walletCliExitCode": proc.returncode,
            "workflowError": "harness-output-not-json",
        }
    payload.setdefault("workflowSubprocessExitCode", proc.returncode)
    return payload


def final_object(result: dict[str, Any]) -> dict[str, Any]:
    final = result.get("final")
    return final if isinstance(final, dict) else {}


def descriptor_info(descriptor: str) -> dict[str, str]:
    parts = descriptor.split(":")
    if len(parts) >= 7 and parts[:3] == ["account", "1", "address"]:
        return {
            "network": parts[3],
            "chain": parts[4],
            "address": parts[5],
            "path": ":".join(parts[6:]),
        }
    return {"network": "", "chain": "", "address": "", "path": ""}


def parse_amount(amount_text: str) -> tuple[Decimal | None, str, str]:
    normalized = amount_text.replace("\u00a0", " ").strip()
    match = re.match(r"^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s+(.+)$", normalized)
    if not match:
        return None, "", normalized
    number_text, ticker = match.groups()
    try:
        value = Decimal(number_text)
    except InvalidOperation:
        return None, ticker.strip(), normalized
    return value, ticker.strip(), normalized


def format_decimal(value: Decimal) -> str:
    if value == value.to_integral():
        return str(value.quantize(Decimal(1)))
    return format(value.normalize(), "f")


def balance_all(include_zero_assets: bool = False) -> int:
    session_result = run_harness(["session", "view"], timeout=30)
    session_final = final_object(session_result)
    accounts = session_final.get("accounts", [])
    if not session_result.get("ok") or not isinstance(accounts, list):
        return emit(
            {
                "ok": False,
                "workflow": "balance-all",
                "source": "wallet-cli",
                "session": session_result,
            },
            1,
        )

    labels: list[dict[str, str]] = []
    for account in accounts:
        if not isinstance(account, dict):
            continue
        label = str(account.get("label", ""))
        descriptor = str(account.get("descriptor", ""))
        if not label:
            continue
        labels.append({"label": label, "descriptor": descriptor, **descriptor_info(descriptor)})

    rows: list[dict[str, Any]] = []
    nonzero: list[dict[str, Any]] = []
    zero_labels: list[str] = []
    errors: list[dict[str, Any]] = []
    totals: dict[str, Decimal] = defaultdict(Decimal)

    for account in labels:
        label = account["label"]
        result = run_harness(["balances", label], timeout=60)
        final = final_object(result)
        balances = final.get("balances", [])
        if not result.get("ok") or not isinstance(balances, list):
            errors.append({"label": label, "result": result})
            continue

        account_rows: list[dict[str, Any]] = []
        account_nonzero: list[dict[str, Any]] = []
        zero_asset_count = 0
        for balance in balances:
            if not isinstance(balance, dict):
                continue
            amount_text = str(balance.get("amount", ""))
            value, ticker, normalized = parse_amount(amount_text)
            row = {
                "label": label,
                "asset": balance.get("asset", ""),
                "amount": normalized,
                "ticker": ticker,
            }
            if include_zero_assets:
                account_rows.append(row)
            if value is not None and value != 0:
                row["decimalAmount"] = format_decimal(value)
                account_nonzero.append(row)
                nonzero.append(row)
                if ticker:
                    totals[ticker] += value
            else:
                zero_asset_count += 1

        if not account_nonzero:
            zero_labels.append(label)

        rows.append(
            {
                "label": label,
                "address": account.get("address", ""),
                "network": final.get("network") or account.get("network", ""),
                "ok": True,
                "nonzeroBalances": account_nonzero,
                "zeroAssetCount": zero_asset_count,
                **({"balances": account_rows} if include_zero_assets else {}),
            }
        )

    totals_list = [
        {"ticker": ticker, "amount": format_decimal(value)}
        for ticker, value in sorted(totals.items())
    ]
    nonzero.sort(key=lambda item: (str(item.get("ticker", "")), Decimal(str(item.get("decimalAmount", "0")))), reverse=True)

    return emit(
        {
            "ok": not errors,
            "workflow": "balance-all",
            "source": "wallet-cli",
            "accountsChecked": len(labels),
            "labels": labels,
            "totals": totals_list,
            "nonzeroBalances": nonzero,
            "zeroLabels": zero_labels,
            "accounts": rows,
            "errors": errors,
        },
        0 if not errors else 1,
    )


def discover(network: str) -> int:
    result = run_harness(["account", "discover", network, "--device-timeout", "60000"], timeout=75, process_timeout=70)
    return emit(
        {
            "ok": bool(result.get("ok")),
            "workflow": "discover",
            "network": network,
            "source": "wallet-cli",
            "result": result,
        },
        0 if result.get("ok") else 1,
    )


def device_check(device_timeout_ms: int = 10000, timeout_seconds: int = 15) -> int:
    result = run_harness(
        ["genuine-check", "--device-timeout", str(device_timeout_ms)],
        timeout=timeout_seconds + 5,
        process_timeout=timeout_seconds,
    )
    final = final_object(result)
    return emit(
        {
            "ok": bool(result.get("ok")),
            "workflow": "device-check",
            "source": "wallet-cli",
            "bounded": True,
            "deviceTimeoutMs": device_timeout_ms,
            "timeoutSeconds": timeout_seconds,
            "genuine": final.get("genuine") if final else None,
            "result": result,
        },
        0 if result.get("ok") else 1,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Run wallet-cli-only Codex workflows.")
    subparsers = parser.add_subparsers(dest="workflow", required=True)

    balance_parser = subparsers.add_parser("balance-all", help="Check balances for every saved wallet-cli label.")
    balance_parser.add_argument("--include-zero-assets", action="store_true", help="Include every zero asset row.")

    discover_parser = subparsers.add_parser("discover", help="Discover accounts for a wallet-cli network.")
    discover_parser.add_argument("--network", required=True, choices=["bitcoin", "ethereum", "solana"])

    device_parser = subparsers.add_parser("device-check", help="Run a bounded wallet-cli genuine-check.")
    device_parser.add_argument("--device-timeout-ms", type=int, default=10000)
    device_parser.add_argument("--timeout-seconds", type=int, default=15)

    args = parser.parse_args()
    if args.workflow == "balance-all":
        return balance_all(include_zero_assets=args.include_zero_assets)
    if args.workflow == "discover":
        return discover(network=args.network)
    if args.workflow == "device-check":
        return device_check(device_timeout_ms=args.device_timeout_ms, timeout_seconds=args.timeout_seconds)
    return emit({"ok": False, "error": f"Unknown workflow: {args.workflow}"}, 2)


if __name__ == "__main__":
    raise SystemExit(main())
