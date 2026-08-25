"""Shared pytest fixtures/setup for the whole test suite.

sync.py reads STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET from the environment at
import time (real credentials, normally supplied via .env for an actual
sync run). The unit/integration tests never talk to the real Strava API —
every network call is mocked — so harmless placeholders are set here
before sync.py gets imported by any test module, rather than requiring a
real .env to exist just to run the suite.
"""
import http.server
import os
import socket
import sys
import threading
from pathlib import Path

import pytest

os.environ.setdefault('STRAVA_CLIENT_ID', 'test-client-id')
os.environ.setdefault('STRAVA_CLIENT_SECRET', 'test-client-secret')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

SITE_DIR = Path(__file__).resolve().parent.parent / 'site'


def pytest_addoption(parser):
    parser.addoption(
        '--update-snapshots', action='store_true', default=False,
        help='Write visual-regression baselines instead of comparing against them (tests/test_visual.py).',
    )


def _free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


@pytest.fixture(scope='session')
def server_url():
    """Serves site/ on its own local port for the duration of the test
    session — independent of any dev server already running elsewhere, so
    the suite works standalone. Shared by test_e2e.py and test_visual.py."""
    port = _free_port()
    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(*a, directory=str(SITE_DIR), **kw)
    httpd = http.server.ThreadingHTTPServer(('localhost', port), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f'http://localhost:{port}'
    httpd.shutdown()
