#!/usr/bin/env python3
"""Preserve a legacy ledger and tighten missing-usage reserves using known prices.

This does not reconstruct usage or change task outcomes. It retains the legacy
worst-case token allowance, replacing peak-Pro prices with independently checked
request-time model prices. Run only after the source ledger stops changing.
"""
import argparse
import datetime
from decimal import Decimal, ROUND_CEILING
import hashlib
import json
from pathlib import Path
import re
import sys


def request_rates(model, stamp, pricing):
    date = datetime.datetime.fromtimestamp(stamp, datetime.timezone.utc)
    peak = date.weekday() in pricing['peak_weekdays_utc'] and any(
        start <= date.hour < end for start, end in pricing['peak_hours_utc'])
    multiplier = pricing['peak_multiplier'] if peak else 1
    return [Decimal(str(value)) * multiplier
            for value in pricing['models'][model]['usd_per_million_tokens']]


def reconcile_record(record, body, pricing):
    result = dict(record)
    if not record.get('usage_missing'):
        return result
    if record.get('usage') or record.get('input_tokens', 0) or record.get('output_tokens', 0) or record.get('cost_usd', 0):
        raise ValueError('Missing-usage record contains conflicting measured usage')
    if body.get('model') != record.get('model'):
        raise ValueError('Wire and accounting models differ')
    rates = request_rates(record['model'], record['time'], pricing)
    if len(record.get('rates', [])) != 3 or any(
        abs(Decimal(str(actual)) - expected) > Decimal('0.000000001')
        for actual, expected in zip(record['rates'], rates)):
        raise ValueError('Captured rates do not match verified pricing')
    cap = body.get('max_tokens', body.get('max_completion_tokens'))
    if isinstance(cap, bool) or not isinstance(cap, int) or not 1 <= cap <= 8192:
        raise ValueError('Unsupported output cap')
    # This is precisely the legacy allowance. No tokenizer, cache-hit or
    # successful-task assumption is introduced by this reconciliation.
    chars = len(json.dumps(body))
    legacy = (Decimal(chars) * Decimal('1.32') + Decimal(cap) * Decimal('3.96')) / 1_000_000
    old = Decimal(str(record['budget_charge_usd']))
    if abs(old - legacy) > Decimal('0.000000001'):
        raise ValueError('Reserve does not match the captured legacy request')
    bound = ((Decimal(chars) * rates[1] + Decimal(cap) * rates[2]) / 1_000_000).quantize(
        Decimal('0.000000001'), rounding=ROUND_CEILING)
    if bound < old - Decimal('0.000000001'):
        result['original_budget_charge_usd'] = record['budget_charge_usd']
        result['budget_charge_usd'] = float(bound)
        result['budget_charge_basis'] = 'request-time-price-upper-bound'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, required=True)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--pricing', type=Path, default=Path(__file__).with_name('pricing.json'))
    args = parser.parse_args()
    if sys.platform != 'linux':
        parser.error('Run accounting reconciliation on Linux')
    if args.out.exists() or args.report.exists() or args.source.resolve() == args.out.resolve():
        raise ValueError('Choose new destinations; the original ledger is immutable')
    source = args.source.read_bytes()
    pricing = json.loads(args.pricing.read_text())
    output, adjustments = [], []
    for line in source.decode().splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        if record.get('usage_missing'):
            if not re.fullmatch(r'[A-Za-z0-9_-]+', record['run']) or not isinstance(record['call'], int) or record['call'] < 1:
                raise ValueError('Unsafe call identity')
            wire = args.root / 'runs' / record['run'] / f"wire-{record['call']:03}.json"
            wire_data = wire.read_bytes()
            result = reconcile_record(record, json.loads(wire_data)['body'], pricing)
            if 'original_budget_charge_usd' in result:
                adjustments.append({key: result[key] for key in ('run', 'call', 'model', 'original_budget_charge_usd', 'budget_charge_usd', 'budget_charge_basis')} |
                                   {'wire_sha256': hashlib.sha256(wire_data).hexdigest()})
        else:
            result = record
        output.append(result)
    if args.source.read_bytes() != source:
        raise RuntimeError('Source ledger changed during reconciliation')
    report = {'schema_version': 1, 'source_sha256': hashlib.sha256(source).hexdigest(),
              'pricing_sha256': hashlib.sha256(args.pricing.read_bytes()).hexdigest(),
              'calls': len(output), 'adjustments': adjustments,
              'original_charge_usd': sum(r.get('original_budget_charge_usd', r.get('budget_charge_usd', r['cost_usd'])) for r in output),
              'reconciled_charge_usd': sum(r.get('budget_charge_usd', r['cost_usd']) for r in output),
              'interpretation': 'Known request-time prices with unchanged legacy token upper bounds. Usage remains missing. Raw source ledger and task results are unchanged.'}
    args.out.write_text(''.join(json.dumps(record) + '\n' for record in output))
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({key: report[key] for key in ('calls', 'original_charge_usd', 'reconciled_charge_usd')} | {'adjusted_calls': len(adjustments)}))


if __name__ == '__main__':
    main()
