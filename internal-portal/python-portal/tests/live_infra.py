"""Live infrastructure guards for integration and hard test suites.

Mirrors the MAIA/tests/live_infra.py API (LIVE_TESTS_ENABLED, require_live_llm,
require_db) so hard tests skip gracefully in offline CI. Stdlib only and
importable under both pytest and unittest: skips raise ``pytest.skip`` when
pytest is present, otherwise ``unittest.SkipTest``.
"""
from __future__ import annotations

import os
import socket
import unittest
import urllib.request


def _skip(reason: str) -> None:
    # unittest.SkipTest is honored by BOTH runners (pytest natively treats
    # it as a skip), unlike pytest.skip which escapes unittest handlers.
    raise unittest.SkipTest(reason)

LIVE_TESTS_ENABLED = os.environ.get("LIVE_TESTS", "").lower() in ("1", "true", "yes")


def is_port_open(host: str, port: int, timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (socket.timeout, OSError):
        return False


def is_http_reachable(url: str, timeout: float = 1.5) -> bool:
    try:
        req = urllib.request.Request(url, method="HEAD")
        with urllib.request.urlopen(req, timeout=timeout):
            return True
    except Exception:
        # Retry with GET in case HEAD is not allowed
        try:
            req = urllib.request.Request(url, method="GET")
            with urllib.request.urlopen(req, timeout=timeout):
                return True
        except Exception:
            return False


def require_live_llm(base_url: str = "http://127.0.0.1:8787/health"):
    if not LIVE_TESTS_ENABLED:
        _skip("Skipping live LLM test: LIVE_TESTS!=1")
    if not is_http_reachable(base_url):
        _skip(f"Skipping live LLM test: {base_url} is unreachable")


def require_db(kind: str = "postgres"):
    if not LIVE_TESTS_ENABLED:
        _skip(f"Skipping live DB test ({kind}): LIVE_TESTS!=1")
