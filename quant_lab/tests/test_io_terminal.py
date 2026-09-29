import io
import json
import sys

import pytest

from robot_quant import research_chunk


class Stream:
    def __init__(self, buffer):
        self.buffer = buffer

    def write(self, value):
        return self.buffer.write(value.encode())


class AckInput(io.BytesIO):
    def __init__(self, request, output, ack):
        super().__init__(request + ack)
        self.output = output
        self.checked = False

    def readline(self, size=-1):
        if self.tell() > 0:
            self.checked = True
            assert self.output.flushed
            assert self.output.getvalue() == b'{"checkpoint":{},"result":null}\n'
        return super().readline(size)


class FlushedOutput(io.BytesIO):
    flushed = False

    def flush(self):
        self.flushed = True
        super().flush()


@pytest.fixture
def ipc(monkeypatch):
    monkeypatch.setattr(research_chunk, "prepare_io_telemetry", lambda: None)
    monkeypatch.setattr(research_chunk, "evaluate_chunk", lambda request: {"checkpoint": {}, "result": None})
    return monkeypatch


def terminal_environment(monkeypatch):
    monkeypatch.setenv("QUANT_IO_TERMINAL_PROTOCOL", "quant-io-terminal-v1")
    for name in ("QUANT_IO_READY_FILE", "QUANT_IO_READY_DEVICE", "QUANT_IO_READY_RBPS", "QUANT_IO_READY_WBPS"):
        monkeypatch.setenv(name, "present")


def test_terminal_frame_flushes_before_exact_ack(ipc):
    terminal_environment(ipc)
    output = FlushedOutput()
    input_stream = AckInput(b'{}\n', output, b'QUANT_IO_TERMINAL_ACK_V1\n')
    ipc.setattr(sys, "stdin", Stream(input_stream))
    ipc.setattr(sys, "stdout", Stream(output))
    research_chunk.main()
    assert input_stream.checked


@pytest.mark.parametrize("ack", [b'', b'WRONG\n', b'X' * 65 + b'\n', b'QUANT_IO_TERMINAL_ACK_V1\nX'])
def test_terminal_rejects_missing_wrong_or_long_ack(ipc, ack):
    terminal_environment(ipc)
    output = FlushedOutput()
    ipc.setattr(sys, "stdin", Stream(AckInput(b'{}\n', output, ack)))
    ipc.setattr(sys, "stdout", Stream(output))
    with pytest.raises(SystemExit) as error:
        research_chunk.main()
    assert error.value.code == 1
    assert output.getvalue() == b'{"checkpoint":{},"result":null}\n'


@pytest.mark.parametrize("protocol", ["unknown", "quant-io-terminal-v1"])
def test_terminal_rejects_unknown_or_partial_configuration(ipc, protocol):
    ipc.setenv("QUANT_IO_TERMINAL_PROTOCOL", protocol)
    for name in ("QUANT_IO_READY_FILE", "QUANT_IO_READY_DEVICE", "QUANT_IO_READY_RBPS", "QUANT_IO_READY_WBPS"):
        ipc.delenv(name, raising=False)
    output = FlushedOutput()
    ipc.setattr(sys, "stdin", Stream(io.BytesIO(b'{}\n')))
    ipc.setattr(sys, "stdout", Stream(output))
    with pytest.raises(SystemExit) as error:
        research_chunk.main()
    assert error.value.code == 1


def test_legacy_eof_request_unchanged(ipc):
    ipc.delenv("QUANT_IO_TERMINAL_PROTOCOL", raising=False)
    output = FlushedOutput()
    ipc.setattr(sys, "stdin", Stream(io.BytesIO(json.dumps({}).encode())))
    ipc.setattr(sys, "stdout", Stream(output))
    research_chunk.main()
    assert output.getvalue() == b'{"checkpoint":{},"result":null}\n'
