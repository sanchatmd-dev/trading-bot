"""Diagnostic child accepts one fixed payload only after telemetry preparation."""

import io
import os
import pathlib
import subprocess
import sys

import pytest

from robot_quant import io_runtime_probe


class Output:
    def __init__(self):
        self.buffer = io.BytesIO()


@pytest.mark.parametrize("payload", [b'', b'{"mode":"ok"}\n', b'{"mode":"sleep"}\nextra', b'{"mode":"sleep"}'])
def test_probe_rejects_every_other_payload(monkeypatch, payload):
    output = Output()
    monkeypatch.setattr(io_runtime_probe.sys, "stdout", output)
    prepared = []
    with pytest.raises(ValueError, match="INVALID_QUANT_PROCESS_PAYLOAD"):
        io_runtime_probe.main(prepare=lambda: prepared.append(True), input_stream=io.BytesIO(payload),
                              sleeper=lambda _: pytest.fail("sleep started"))
    assert prepared == [True]
    assert output.buffer.getvalue() == b''


def test_probe_prepares_before_read_and_emits_exact_receipt(monkeypatch):
    output = Output()
    monkeypatch.setattr(io_runtime_probe.sys, "stdout", output)
    events = []

    class Input(io.BytesIO):
        def readline(self, *args):
            assert events == ["prepared"]
            return super().readline(*args)

    io_runtime_probe.main(prepare=lambda: events.append("prepared"),
                          input_stream=Input(io_runtime_probe.PAYLOAD),
                          sleeper=lambda seconds: events.append(seconds))
    assert events == ["prepared", 60]
    assert output.buffer.getvalue() == io_runtime_probe.ACCEPTED


def test_script_uses_stdlib_without_robot_quant_package_import():
    script = pathlib.Path(io_runtime_probe.__file__)
    environment = {key: value for key, value in os.environ.items() if not key.startswith("QUANT_IO_READY_")}
    result = subprocess.run([sys.executable, "-I", str(script)], input=io_runtime_probe.PAYLOAD,
                            env=environment, capture_output=True, timeout=5, check=False)
    assert result.returncode != 0
    assert b"QUANT_IO_READINESS_CONFIGURATION_REQUIRED" in result.stderr
    assert b"ModuleNotFoundError" not in result.stderr
