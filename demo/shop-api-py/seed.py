"""Seed the demo database."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from store import open_db  # noqa: E402

out = sys.argv[1] if len(sys.argv) > 1 else "seed/seed.db"
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
open_db(out)
print(f"seeded {out}")
