#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_support import setup
setup('07-source-manifest', Path(sys.argv[1]).resolve())
