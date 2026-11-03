"""Start the Python shop API (stdlib only)."""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import app  # noqa: E402
from router import serve  # noqa: E402

if __name__ == "__main__":
    serve(app, int(os.environ.get("PORT", "8101")))
