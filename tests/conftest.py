"""Shared pytest fixtures/setup for the whole test suite.

sync.py reads STRAVA_CLIENT_ID/STRAVA_CLIENT_SECRET from the environment at
import time (real credentials, normally supplied via .env for an actual
sync run). The unit/integration tests never talk to the real Strava API —
every network call is mocked — so harmless placeholders are set here
before sync.py gets imported by any test module, rather than requiring a
real .env to exist just to run the suite.
"""
import os
import sys

os.environ.setdefault('STRAVA_CLIENT_ID', 'test-client-id')
os.environ.setdefault('STRAVA_CLIENT_SECRET', 'test-client-secret')

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
