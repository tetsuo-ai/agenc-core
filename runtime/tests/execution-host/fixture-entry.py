#!/usr/bin/python3 -I
"""Fixture entrypoint; only the immutable host installation enters sys.path."""
import runpy
import traceback
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, "/opt/agenc-execution/host")
try:
    runpy.run_path("/opt/agenc-execution/host/runtime_adapter.py", run_name="__main__")
except SystemExit as error:
    if error.code not in (None, 0):
        with open("/var/lib/agenc-execution/fixture-runtime-errors.log", "a") as diagnostics:
            traceback.print_exc(file=diagnostics)
    raise
