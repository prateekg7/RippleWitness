"""In-process string-keyed event bus (dict registry)."""

_handlers = {}


def on(event, handler):
    _handlers.setdefault(event, []).append(handler)


def emit(event, payload):
    for h in _handlers.get(event, []):
        h(payload)


def reset():
    _handlers.clear()
