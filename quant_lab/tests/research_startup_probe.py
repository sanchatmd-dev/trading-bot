"""Fresh-process startup fixture with synthetic cgroup I/O, never host telemetry."""

import builtins
import io
import json
import os
import runpy
import sys
import time
from types import SimpleNamespace

started = time.perf_counter()
mode = os.environ.get("QUANT_TEST_STARTUP_MODE", "ready_only")
# "0" leaves QUANT_IO_TERMINAL_PROTOCOL unset, as the local supervisor does without ioControls.
terminal = os.environ.get("QUANT_TEST_STARTUP_TERMINAL", "1") == "1"
events = os.environ["QUANT_TEST_STARTUP_EVENTS"]
original_open = builtins.open
original_import = builtins.__import__
original_stat = os.stat
original_os_open = os.open
original_write = os.write
original_fsync = os.fsync
original_close = os.close
original_realpath = os.path.realpath
original_exists = os.path.exists
ready = False
injected = None
synced = False
counters_read = False
filename = "/quant-test/.pending-startup"
group = "/sys/fs/cgroup/quant-test"
descriptor = 987654


def record(event, **fields):
    with original_open(events, "a", encoding="utf-8") as stream:
        stream.write(json.dumps({"event": event, "ms": (time.perf_counter() - started) * 1000, **fields}) + "\n")


def fake_open(name, *args, **kwargs):
    global counters_read
    normalized = os.fspath(name).replace("\\", "/")
    if normalized == "/proc/self/cgroup":
        return io.StringIO("0::/quant-test\n")
    if normalized == group + "/io.max":
        return io.StringIO("8:0 rbps=1048576 wbps=1048576\n")
    if normalized == group + "/io.stat":
        assert synced, "counters checked before fsync"
        counters_read = True
        return io.StringIO("8:0 rbytes=0 wbytes=4096\n")
    return original_open(name, *args, **kwargs)


def fake_stat(name, *args, **kwargs):
    if os.fspath(name).replace("\\", "/") in ("/quant-test", group):
        return SimpleNamespace(st_dev=2048, st_ino=123)
    return original_stat(name, *args, **kwargs)


def fake_os_open(name, flags, permissions=0o777, **kwargs):
    if name == filename:
        assert flags == os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW
        assert permissions == 0o600
        record("scratch_created")
        return descriptor
    return original_os_open(name, flags, permissions, **kwargs)


def fake_write(fd, data):
    if fd == descriptor:
        assert data == b"Q" * 4096
        return len(data)
    return original_write(fd, data)


def fake_fsync(fd):
    global synced
    if fd == descriptor:
        synced = True
        return
    return original_fsync(fd)


def imports(name, *args, **kwargs):
    global injected
    if name in ("robot_quant.bridge_replay", "robot_quant.paper_state", "robot_quant.spt_custom_evaluator"):
        record("evaluation_import", module=name, ready=ready)
        if mode == "fail:" + name:
            injected = name
            raise ImportError("INJECTED_HEAVY_IMPORT_FAILURE")
    return original_import(name, *args, **kwargs)


def profile(frame, event, arg):
    global ready
    if event == "return" and frame.f_code.co_name == "prepare_io_telemetry" and synced and counters_read:
        ready = True
        record("ready")
        if mode == "ready_only":
            raise SystemExit(0)


os.environ.update(QUANT_IO_READY_FILE=filename, QUANT_IO_READY_DEVICE="8:0",
                  QUANT_IO_READY_RBPS="1048576", QUANT_IO_READY_WBPS="1048576")
if terminal:
    os.environ["QUANT_IO_TERMINAL_PROTOCOL"] = "quant-io-terminal-v1"
builtins.open = fake_open
builtins.__import__ = imports
os.stat = fake_stat
os.open = fake_os_open
os.write = fake_write
os.fsync = fake_fsync
os.close = lambda fd: None if fd == descriptor else original_close(fd)
os.path.realpath = lambda name, **kw: name if name.startswith("/sys/dev/block/") else original_realpath(name, **kw)
os.path.exists = lambda name: True if name.startswith("/sys/dev/block/") else original_exists(name)
os.major = lambda device: 8
os.minor = lambda device: 0
os.O_NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
sys.setprofile(profile)
try:
    runpy.run_module("robot_quant.research_chunk", run_name="__main__")
except ImportError as error:
    # The exception that ends the child, as its stderr traceback shows; the supervisor keeps only a byte count.
    record("import_failed", module=injected, ready=ready, message=str(error))
    raise
