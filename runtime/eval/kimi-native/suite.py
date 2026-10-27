#!/usr/bin/env python3
"""Resume the native CLI matrix and spend an explicitly requested stress budget."""
import argparse
import json
import pathlib
import subprocess
import sys

from fixtures import TASKS
from run import api, save

HERE = pathlib.Path(__file__).resolve().parent
ORDER = ('kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed', 'kimi-k3',
         'kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k2.6')


def stress_target(ledger, context):
    """Leave room for the token reservation and subsequent tool round trips."""
    accounted = max(ledger['spent'], ledger.get('priorSpend', 0) + ledger.get('usageSpend', 0) * 1.1)
    remaining = min(ledger['cap'] - accounted,
                    ledger['lastBalance']['available_balance'] - ledger['balanceFloor']
                    - (accounted - ledger['spent']))
    # The wire guard remains authoritative for every individual request.
    # Budget at the most expensive offered model's cold-input rate, plus the
    # 12 USD/MTok admission envelope, framing and the 4096-token output reserve.
    tokens = int((remaining - 0.6) / (13.2e-6 + 8.8e-6))
    return min(tokens, 500000 if context > 500000 else 200000, context - 32768)


def run_one(args, model, task, repeat, **extra):
    label = f'after-{model}-{task}-{repeat}'
    directory = args.evidence / label
    if directory.exists():
        result = directory / 'result.json'
        if not result.exists() or not json.loads(result.read_text())['solve']:
            raise SystemExit('Investigate existing unsuccessful run: ' + label)
        return
    command = [sys.executable, str(HERE / 'run.py'), '--sweep', str(args.sweep),
               '--evidence', str(args.evidence), '--model', model, '--task', task,
               '--repeat', str(repeat), '--phase', 'after']
    for key, value in extra.items():
        command += ['--' + key.replace('_', '-'), str(value)]
    subprocess.run(command, check=True)
    if not json.loads((directory / 'result.json').read_text())['solve']:
        raise SystemExit('Investigate failed run before spending more: ' + label)


def stress_case(ledger, context, repeat):
    target = stress_target(ledger, context)
    # A large prompt needs a larger reservation than a short tool loop. Keep
    # the same wire guard and spend the final authorized portion on repeated
    # reasoning tasks rather than stopping below the requested USD target.
    return ('replay', {}) if target < 96000 else (
        'long-context', {'seed': repeat, 'target_tokens': target})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sweep', type=pathlib.Path, required=True)
    parser.add_argument('--evidence', type=pathlib.Path, required=True)
    parser.add_argument('--first-repeat', type=int, default=10)
    parser.add_argument('--first-stress-repeat', type=int, default=100,
                        help='Resume after an investigated failure and a separately recorded confirmation')
    parser.add_argument('--stress-only', action='store_true')
    parser.add_argument('--target-spend', type=float, default=0,
                        help='Explicit native USD target, including existing priced usage')
    args = parser.parse_args()
    ledger_path = args.evidence / 'ledger.json'
    if not ledger_path.exists():
        raise SystemExit('Initialize and reconcile the owner ledger with run.py first')
    ledger = json.loads(ledger_path.read_text())
    if not 0 <= args.target_spend <= ledger['cap']:
        raise SystemExit('Target must be nonnegative and within the owner cap')
    models = {m['id']: m for m in api('models')['data']}
    if set(models) != set(ORDER):
        raise SystemExit('Native inventory changed; review capabilities and prices first')
    start_path = args.evidence / ('stress-balance-start.json' if args.stress_only else 'suite-balance-start.json')
    if not start_path.exists():
        save(start_path, api('users/me/balance')['data'])
    if not args.stress_only:
        for model in ORDER:
            for task in TASKS:
                for repeat in range(args.first_repeat, args.first_repeat + 2):
                    run_one(args, model, task, repeat)
    for repeat in range(args.first_stress_repeat, args.first_stress_repeat + 900):
        ledger = json.loads(ledger_path.read_text())
        if ledger.get('pending'):
            raise SystemExit('Unsettled reservation requires investigation')
        if ledger.get('usageSpend', 0) >= args.target_spend:
            break
        model = ORDER[(repeat - 100) % len(ORDER)]
        task, extra = stress_case(ledger, models[model]['context_length'], repeat)
        run_one(args, model, task, repeat, **extra)
    save(args.evidence / 'suite-balance-end.json', api('users/me/balance')['data'])


if __name__ == '__main__':
    main()
