#!/usr/bin/env python3
"""RippleWitness Python static extractor (F-20, TRD 7.1.2).

Stdlib only (`ast`); zero new dependencies. Emits the same deterministic
graph JSON as the ts-morph extractor: route:/fn:/db:/config: nodes.
Usage: python3 extract.py <appRoot>  (graph JSON on stdout; diagnostics on stderr)

Coverage: FastAPI/Starlette decorators (@app.get, @router.post, include_router),
Flask decorators (@app.route, blueprints). Name-based call resolution to depth 3,
mirroring the TS extractor. Documented blind spots (never statically trusted):
getattr/string dispatch, decorator-swapped callables, Celery/RQ task routing.
"""

import ast
import json
import os
import re
import sys

ROUTE_METHODS = {"get", "post", "put", "patch", "delete"}
# Calls never treated as project edges (mirror of the TS extractor's exclusions).
SKIP_CALLS = {
    "print", "len", "str", "int", "float", "bool", "list", "dict", "set",
    "tuple", "range", "open", "isinstance", "hasattr", "super", "getattr",
    "eval", "exec", "__import__",
}
SKIP_METHODS = {
    "get", "post", "put", "patch", "delete", "route", "append", "extend",
    "items", "keys", "values", "format", "join", "split", "strip", "encode",
    "decode", "dumps", "loads", "json", "fetchall", "fetchone", "commit",
    "close", "add", "update", "setdefault", "pop", "use", "on", "emit",
    "listen", "status", "run", "all", "exec", "set",
}
MAX_CALL_DEPTH = 3
SQL_TABLE_RE = re.compile(
    r"\b(?:FROM|JOIN|INTO|UPDATE)\s+[\"'`\[]?([A-Za-z_][\w]*)", re.IGNORECASE
)
SKIP_DIRS = {"__pycache__", ".venv", "venv", ".git", "node_modules", "tests", "site-packages"}


def iter_py_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if d not in SKIP_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            if not fn.endswith(".py"):
                continue
            if fn.startswith("test_") or fn.endswith("_test.py") or fn == "conftest.py":
                continue
            out.append(os.path.join(dirpath, fn))
    return sorted(out)


def const_str(node):
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


def normalize_param(path):
    path = re.sub(r"\{([A-Za-z_][\w]*)\}", r":\1", path)  # FastAPI {id} -> :id
    path = re.sub(r"<(?:[A-Za-z_][\w]*:)?([A-Za-z_][\w]*)>", r":\1", path)  # Flask <id>/<int:id>
    return path


class FileFacts:
    def __init__(self, path, rel, tree):
        self.path = path
        self.rel = rel
        self.tree = tree
        self.app_vars = set()  # FastAPI()/Flask() instances
        self.router_vars = {}  # var -> prefix (APIRouter/Blueprint)
        self.funcs = {}  # qualname -> node (module fns + Class.method)
        self.imports = {}  # local alias -> (module, name or None)
        self.routes = []  # (method, path, handler_qual, deco_lineno, end_lineno)
        self.prefix_overrides = []  # (router_var, prefix) from include/register calls


def collect_facts(path, rel, tree):
    f = FileFacts(path, rel, tree)
    for node in ast.walk(tree):
        if isinstance(node, (ast.ImportFrom,)):
            mod = node.module or ""
            for a in node.names:
                f.imports[a.asname or a.name] = (mod, a.name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                f.imports[(a.asname or a.name).split(".")[0]] = (a.name, None)
    for node in tree.body:
        if isinstance(node, ast.ClassDef):
            for item in node.body:
                if isinstance(item, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    f.funcs[f"{node.name}.{item.name}"] = item
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            f.funcs[node.name] = node
        elif isinstance(node, ast.Assign) and len(node.targets) == 1:
            t = node.targets[0]
            if isinstance(t, ast.Name) and isinstance(node.value, ast.Call):
                func = node.value.func
                cname = func.id if isinstance(func, ast.Name) else (
                    func.attr if isinstance(func, ast.Attribute) else "")
                if cname in ("FastAPI", "Flask"):
                    f.app_vars.add(t.id)
                elif cname == "APIRouter":
                    prefix = ""
                    for kw in node.value.keywords:
                        if kw.arg == "prefix":
                            prefix = const_str(kw.value) or ""
                    f.router_vars[t.id] = prefix
                elif cname == "Blueprint":
                    prefix = ""
                    for kw in node.value.keywords:
                        if kw.arg == "url_prefix":
                            prefix = const_str(kw.value) or ""
                    f.router_vars[t.id] = prefix
    # include_router / register_blueprint prefix overrides (module level or anywhere)
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
            if node.func.attr in ("include_router", "register_blueprint") and node.args:
                rv = node.args[0].id if isinstance(node.args[0], ast.Name) else ""
                for kw in node.keywords:
                    if kw.arg in ("prefix", "url_prefix"):
                        p = const_str(kw.value)
                        if rv and p is not None:
                            f.prefix_overrides.append((rv, p))
    # route decorators
    for qual, fn in f.funcs.items():
        for deco in fn.decorator_list:
            if not (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute)):
                continue
            recv = deco.func.value
            if not (isinstance(recv, ast.Name)):
                continue
            attr = deco.func.attr
            is_app = recv.id in f.app_vars
            is_router = recv.id in f.router_vars
            if not (is_app or is_router):
                continue
            if attr in ROUTE_METHODS:
                p = deco.args[0] if deco.args else None
                path = const_str(p) if p is not None else None
                if path is None:
                    continue
                f.routes.append((attr.upper(), path, qual, deco.lineno, fn.end_lineno or fn.lineno))
            elif attr == "route":
                p = deco.args[0] if deco.args else None
                path = const_str(p) if p is not None else None
                if path is None:
                    continue
                methods = ["GET"]
                for kw in deco.keywords:
                    if kw.arg == "methods" and isinstance(kw.value, (ast.List, ast.Tuple)):
                        ms = [const_str(e) for e in kw.value.elts]
                        ms = [m.upper() for m in ms if m]
                        if ms:
                            methods = ms
                for m in methods:
                    f.routes.append((m, path, qual, deco.lineno, fn.end_lineno or fn.lineno))
    return f


def calls_in_body(fn_node):
    """Call nodes directly in this function (do not descend into nested defs)."""
    out = []

    def visit(node):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
                continue
            if isinstance(child, ast.Call):
                out.append(child)
            visit(child)

    visit(fn_node)
    return out


def extract(root):
    root = os.path.abspath(root)
    files = []
    for path in iter_py_files(root):
        rel = os.path.relpath(path, root).replace(os.sep, "/")
        try:
            with open(path, "r", encoding="utf-8") as fh:
                tree = ast.parse(fh.read(), filename=path)
        except (SyntaxError, UnicodeDecodeError, OSError) as e:
            print(f"skip {rel}: {e}", file=sys.stderr)
            continue
        files.append(collect_facts(path, rel, tree))

    # name index for cross-file resolution (exactly-one rule, like the TS extractor)
    by_name = {}
    for f in files:
        for qual in f.funcs:
            short = qual.split(".")[-1]
            by_name.setdefault(short, []).append((f, qual))

    nodes = {}
    edges = set()

    def add_node(nid, kind, label, f=None, rng=None):
        if nid in nodes:
            return
        n = {"id": nid, "kind": kind, "label": label}
        if f is not None:
            n["file"] = f.rel
        if rng is not None:
            n["range"] = rng
        nodes[nid] = n

    def fn_id(f, qual):
        return f"fn:{f.rel}:{qual}"

    def resolve_call(call_file, call_node, self_class=None):
        """Resolve a Call to (file, qualname) or None. Name-based only."""
        func = call_node.func
        if isinstance(func, ast.Name):
            name = func.id
            if name in SKIP_CALLS:
                return None
            # same-file local first
            if name in call_file.funcs:
                return (call_file, name)
            cands = by_name.get(name, [])
            if len(cands) == 1:
                return cands[0]
            return None
        if isinstance(func, ast.Attribute):
            recv = func.value
            # self.method() inside a class
            if isinstance(recv, ast.Name) and recv.id == "self" and self_class:
                qual = f"{self_class}.{func.attr}"
                if qual in call_file.funcs:
                    return (call_file, qual)
                return None
            # module.attr() via import: find defining file by module path suffix
            if isinstance(recv, ast.Name) and recv.id in call_file.imports:
                mod, _ = call_file.imports[recv.id]
                suffix = mod.replace(".", "/") + ".py"
                for f in files:
                    if f.rel.endswith(suffix) and func.attr in f.funcs:
                        return (f, func.attr)
                return None
            return None
        return None

    def scan(fn_file, qual, depth, stack):
        if depth > MAX_CALL_DEPTH:
            return
        key = (fn_file.rel, qual, depth)
        if key in stack:
            return
        stack = stack | {key}
        node = fn_file.funcs[qual]
        self_class = qual.rsplit(".", 1)[0] if "." in qual else None
        if self_class and not any(k.startswith(self_class + ".") for k in fn_file.funcs):
            self_class = None
        src = fn_id(fn_file, qual)
        add_node(src, "service", qual, fn_file, [node.lineno, node.end_lineno or node.lineno])
        for call in calls_in_body(node):
            func = call.func
            # db.execute("...") / .text("..."): table detection (string literals only)
            if isinstance(func, ast.Attribute) and func.attr in ("execute", "executemany", "text"):
                arg = call.args[0] if call.args else None
                sql = const_str(arg) if arg is not None else None
                if sql is not None:
                    is_write = bool(re.match(r"\s*(insert|update|delete|create|drop|alter)\b", sql, re.I))
                    for m in SQL_TABLE_RE.finditer(sql):
                        table = m.group(1)
                        if table.lower() in ("select", "where"):
                            continue
                        tid = f"db:{table}"
                        add_node(tid, "db_table", table)
                        edges.add((src, tid, "writes" if is_write else "reads", "EXTRACTED"))
                continue
            # os.environ / os.getenv / getenv: config reads
            mod_name = None
            if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
                if func.value.id == "os" and func.attr in ("getenv", "environ"):
                    mod_name = func.attr
            if isinstance(func, ast.Name) and func.id in ("getenv",):
                mod_name = func.id
            if mod_name == "getenv" and call.args:
                key = const_str(call.args[0])
                if key:
                    cid = f"config:env:{key}"
                    add_node(cid, "config", f"env:{key}")
                    edges.add((src, cid, "config", "EXTRACTED"))
                continue
            # config.NAME / settings.NAME attribute reads handled below via Name/Attribute walk
            target = resolve_call(fn_file, call, self_class)
            if target is None:
                # Unresolved obj.method() -> INFERRED stub (mirrors the TS extractor).
                if (isinstance(func, ast.Attribute) and func.attr.isidentifier()
                        and func.attr not in SKIP_METHODS):
                    uid = f"fn:unresolved:{func.attr}"
                    add_node(uid, "service", f"{func.attr} (unresolved)")
                    edges.add((src, uid, "calls", "INFERRED"))
                continue
            tf, tqual = target
            dst = fn_id(tf, tqual)
            edges.add((src, dst, "calls", "EXTRACTED"))
            if depth < MAX_CALL_DEPTH:
                scan(tf, tqual, depth + 1, stack)
        # os.environ["X"] subscripts + config.X attribute reads
        for sub in ast.walk(node):
            if isinstance(sub, ast.Subscript) and isinstance(sub.value, ast.Attribute):
                if (isinstance(sub.value.value, ast.Name) and sub.value.value.id == "os"
                        and sub.value.attr == "environ"):
                    key = const_str(sub.slice)
                    if key:
                        cid = f"config:env:{key}"
                        add_node(cid, "config", f"env:{key}")
                        edges.add((src, cid, "config", "EXTRACTED"))
            elif isinstance(sub, ast.Attribute) and isinstance(sub.value, ast.Name):
                if sub.value.id in ("config", "settings") and sub.attr.isupper():
                    cid = f"config:{sub.attr}"
                    add_node(cid, "config", sub.attr)
                    edges.add((src, cid, "config", "EXTRACTED"))

    for f in files:
        prefixes = dict(f.router_vars)
        for rv, p in f.prefix_overrides:
            prefixes[rv] = p
        for method, path, qual, dl, end in f.routes:
            # find owning var prefix: decorator receiver
            fn = f.funcs[qual]
            prefix = ""
            for deco in fn.decorator_list:
                if (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute)
                        and isinstance(deco.func.value, ast.Name)):
                    prefix = prefixes.get(deco.func.value.id, "")
                    break
            full = normalize_param(prefix + path)
            rid = f"route:{method} {full}"
            add_node(rid, "route", full, f, [dl, end])
            hid = fn_id(f, qual)
            edges.add((rid, hid, "calls", "EXTRACTED"))
            scan(f, qual, 1, set())

    node_list = sorted(nodes.values(), key=lambda n: n["id"])
    edge_list = [
        {"from": a, "to": b, "type": t, "confidence": c}
        for (a, b, t, c) in sorted(edges)
    ]
    return {"nodes": node_list, "edges": edge_list}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("usage: extract.py <appRoot>", file=sys.stderr)
        sys.exit(2)
    print(json.dumps(extract(sys.argv[1]), sort_keys=True, separators=(",", ":")))
