#!/usr/bin/env python3
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from task_support import check
check('03-window-padding', Path(sys.argv[1]).resolve())
