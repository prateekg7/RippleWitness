#!/usr/bin/env python3
"""Sandbox function runner for compute scenarios (F-23, TRD 7.4a).

Usage: python3 compute-run.py <module:function> <args.json>
Imports the target from the current working directory (a subject worktree),
calls it with the JSON fixtures, and prints a result envelope on stdout:
  {"ok": true, "value": <json>} | {"ok": false, "error": "<type: message>"}
Array-likes (objects with tolist/shape/dtype, e.g. numpy arrays) serialize as
{"__tensor__": {"shape": [...], "dtype": "...", "values": [...]}} so the
tolerance differ can compare them. Anything else unserializable becomes
{"__repr__": ..., "__type__": ...} — a typed observation, never a crash.
"""

import importlib
import json
import os
import sys


def to_jsonable(value):
    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value
    if isinstance(value, dict):
        return {str(k): to_jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [to_jsonable(v) for v in value]
    tolist = getattr(value, "tolist", None)
    if callable(tolist):
        try:
            return {
                "__tensor__": {
                    "shape": list(getattr(value, "shape", [])),
                    "dtype": str(getattr(value, "dtype", "unknown")),
                    "values": to_jsonable(tolist()),
                }
            }
        except Exception:
            pass
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return {"__repr__": repr(value)[:500], "__type__": type(value).__name__}


def main():
    # Script mode puts the *script's* dir on sys.path; the subject worktree
    # (our cwd) must come first so `import <module>` resolves the subject.
    sys.path.insert(0, os.getcwd())
    if len(sys.argv) != 3:
        print(json.dumps({"ok": False, "error": "usage: compute-run.py <module:function> <args.json>"}))
        return 2
    target, args_path = sys.argv[1], sys.argv[2]
    if ":" not in target:
        print(json.dumps({"ok": False, "error": f"bad target (want module:function): {target}"}))
        return 0
    mod_name, func_name = target.split(":", 1)
    try:
        with open(args_path, "r", encoding="utf-8") as fh:
            call = json.load(fh)
        args = call.get("args", [])
        kwargs = call.get("kwargs", {})
        module = importlib.import_module(mod_name)
        func = getattr(module, func_name)
        result = func(*args, **kwargs)
        print(json.dumps({"ok": True, "value": to_jsonable(result)}))
    except Exception as e:  # noqa: BLE001 - the envelope IS the observation
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"[:500]}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
