#!/usr/bin/env python3
"""Optional SSH stdin credential handoff; never accepts a credential-file path."""
import os
from pathlib import Path
import runpy
import sys

if sys.platform != 'linux':
    raise SystemExit('Benchmark execution requires Linux')
credential = sys.stdin.readline().rstrip('\r\n')
if not credential:
    raise SystemExit('Missing provider credential on stdin')
os.environ['DEEPSEEK_API_KEY'] = credential
credential = ''
runpy.run_path(str(Path(__file__).with_name('runner.py')), run_name='__main__')
