"""Determinism interposition for Python subjects (F-22, TRD §7.4).

Loaded via PYTHONPATH (sitecustomize is imported automatically at startup).
Freezes time.time/datetime.now to FROZEN_TIME, seeds `random` from SEED, and
seeds numpy/torch when importable. PYTHONHASHSEED=0 comes from the runner env
(it must be set before the interpreter starts). Best effort throughout: every
patch is guarded so an exotic runtime degrades to unpatched (the flake guard
still catches drift), never to a broken import.
"""

import datetime as _dtmod
import os as _os
import random as _random
import time as _time

try:
    _FROZEN_TS = _dtmod.datetime.fromisoformat(
        _os.environ.get("FROZEN_TIME", "2026-01-01T00:00:00Z").replace("Z", "+00:00")
    ).timestamp()
except ValueError:
    _FROZEN_TS = 1767225600.0  # 2026-01-01T00:00:00Z

try:
    _time.time = lambda: _FROZEN_TS  # noqa: E731
except (AttributeError, TypeError):
    pass

try:
    _random.seed(int(_os.environ.get("SEED", "42")))
except ValueError:
    pass


class _FrozenDateTime(_dtmod.datetime):
    @classmethod
    def now(cls, tz=None):
        base = _dtmod.datetime.fromtimestamp(_FROZEN_TS)
        return base.replace(tzinfo=tz) if tz is not None else base

    @classmethod
    def utcnow(cls):
        return _dtmod.datetime.fromtimestamp(_FROZEN_TS)


try:
    _dtmod.datetime = _FrozenDateTime
except (AttributeError, TypeError):
    pass

try:
    import numpy as _np

    _np.random.seed(int(_os.environ.get("SEED", "42")))
except ImportError:
    pass

try:
    import torch as _torch

    _torch.manual_seed(int(_os.environ.get("SEED", "42")))
    _torch.use_deterministic_algorithms(True, warn_only=True)
except ImportError:
    pass
