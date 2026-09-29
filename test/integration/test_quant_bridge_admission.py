"""Loopback integration; offline Quant unit tests remain network-disabled."""
import importlib.util
import json
import threading
from concurrent.futures import ThreadPoolExecutor
from http.client import HTTPConnection
from http.server import ThreadingHTTPServer
from pathlib import Path

import pytest


@pytest.fixture
def bridge(monkeypatch):
    script = Path(__file__).resolve().parents[2] / 'src' / 'quant_bridge.py'
    spec = importlib.util.spec_from_file_location('managed_bridge_test', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    server = ThreadingHTTPServer(('127.0.0.1', 0), module.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def request(path, method='POST', body=b'{}'):
        client = HTTPConnection('127.0.0.1', server.server_address[1], timeout=3)
        try:
            client.request(method, path, body=body)
            response = client.getresponse()
            return response.status, json.loads(response.read())
        finally:
            client.close()

    yield module, request
    server.shutdown()
    server.server_close()
    thread.join(timeout=3)
    assert not thread.is_alive()


def test_managed_bridge_denies_before_body_read_or_compute(bridge, monkeypatch):
    module, request = bridge
    monkeypatch.setenv('QUANT_RESEARCH_FOUNDATION_ENABLED', '1')
    calls = []

    def forbidden(*args):
        calls.append(args)
        raise AssertionError('Legacy computation or body parsing was reached')

    monkeypatch.setattr(module, 'backtest', forbidden)
    monkeypatch.setattr(module, 'optimize', forbidden)
    monkeypatch.setattr(module, 'payload', forbidden)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda path: request(path, body=b'not-json'),
                                ['/quant/backtest', '/quant/optimize']))
    assert all(status == 409 and body['code'] == 'QUANT_MANAGED_JOB_REQUIRED'
               for status, body in results)
    assert calls == []
    status, health = request('/quant/health', method='GET', body=None)
    assert status == 200 and health['ok'] and not health['legacy_heavy_enabled']


def test_legacy_bridge_and_managed_risk_preview_remain_available(bridge, monkeypatch):
    module, request = bridge
    monkeypatch.delenv('QUANT_RESEARCH_FOUNDATION_ENABLED', raising=False)
    monkeypatch.setattr(module, 'backtest', lambda body: {'legacy': True})
    assert request('/quant/backtest') == (200, {'legacy': True})
    monkeypatch.setenv('QUANT_RESEARCH_FOUNDATION_ENABLED', '1')
    monkeypatch.setattr(module, 'risk_preview', lambda body: {'sizing': True})
    assert request('/quant/risk-preview') == (200, {'sizing': True})
