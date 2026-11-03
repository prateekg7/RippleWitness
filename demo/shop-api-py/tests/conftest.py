"""Subject-owned suite: spins the app in-process on an ephemeral port."""

import threading

import pytest


@pytest.fixture(scope="session")
def base_url():
    import app as app_module

    server = None
    import socketserver
    from router import Handler

    Handler.router = app_module.app
    server = socketserver.ThreadingTCPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    server.shutdown()
    server.server_close()
