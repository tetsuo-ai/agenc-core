"""Resume only unstarted baseline slots; existing result identity is checked."""
import os
import sys

os.environ['DEEPSEEK_API_KEY'] = sys.stdin.readline().rstrip('\n')
if not os.environ['DEEPSEEK_API_KEY']:
    raise SystemExit('Missing process credential on stdin')
import runner
runner.LEDGER = runner.ROOT / 'spend-reconciled.jsonl'
runner.main()
