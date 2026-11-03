"""Toy linear model (K-03): pure-stdlib floats, weights in model.json."""

import json
import os

_weights = None


def _load():
    global _weights
    if _weights is None:
        here = os.path.dirname(os.path.abspath(__file__))
        with open(os.path.join(here, "model.json"), "r", encoding="utf-8") as fh:
            _weights = json.load(fh)
    return _weights


def predict(features):
    w = _load()
    y = sum(float(f) * float(c) for f, c in zip(features, w["coef"])) + float(w["bias"])
    return {"y": y, "model": w["version"]}
