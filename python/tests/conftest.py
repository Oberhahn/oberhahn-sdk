"""Make ``tests/helpers.py`` importable and the ``src/`` layout resolvable when
running pytest from the ``python/`` directory without an editable install.
"""

from __future__ import annotations

import os
import sys

_HERE = os.path.dirname(__file__)
sys.path.insert(0, _HERE)  # tests/helpers.py
sys.path.insert(0, os.path.join(_HERE, "..", "src"))  # oberhahn package
