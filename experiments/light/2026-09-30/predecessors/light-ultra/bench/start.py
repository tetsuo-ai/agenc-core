"""Read a single bearer from SSH/container stdin into this process only."""
import os, runpy, sys
os.environ['DEEPSEEK_API_KEY'] = sys.stdin.readline().rstrip('\n')
if not os.environ['DEEPSEEK_API_KEY']:
    raise SystemExit('Missing provider credential on stdin')
runpy.run_path('/work/bench/runner.py', run_name='__main__')
