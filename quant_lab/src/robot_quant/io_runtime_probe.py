"""Fixed stdlib-only diagnostic child. No evaluator or market data is imported."""

import hashlib
import os
import re
import stat
import sys
import time

PAYLOAD = b'{"mode":"sleep"}\n'
ACCEPTED = b'QUANT_IO_DIAGNOSTIC_ACCEPTED_V1 ' + hashlib.sha256(PAYLOAD.rstrip(b'\n')).hexdigest().encode() + b'\n'
PENDING = re.compile(r"\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\Z")
DEVICE = re.compile(r"(?:0|[1-9][0-9]*):(?:0|[1-9][0-9]*)\Z")


def _fields(location, name, device):
    with open(os.path.join(location, name), encoding="ascii") as source:
        rows = [line.split() for line in source if line.split() and line.split()[0] == device]
    if len(rows) != 1:
        raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
    values = {}
    for token in rows[0][1:]:
        key, separator, value = token.partition("=")
        if not separator or key in values:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        values[key] = value
    return values


def prepare_io_telemetry():
    """Write and fsync exactly 4 KiB on reviewed device before stdin read."""
    names = ("QUANT_IO_READY_FILE", "QUANT_IO_READY_DEVICE", "QUANT_IO_READY_RBPS", "QUANT_IO_READY_WBPS")
    values = [os.environ.get(name) for name in names]
    if not all(values):
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    filename, device, rbps, wbps = values
    if (not os.path.isabs(filename) or not PENDING.fullmatch(os.path.basename(filename))
            or not DEVICE.fullmatch(device) or any(not rate.isdecimal() or int(rate) < 1024 for rate in (rbps, wbps))):
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    root = os.path.dirname(filename)
    root_identity = os.lstat(root)
    if not stat.S_ISDIR(root_identity.st_mode):
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    actual = os.path.realpath(f"/sys/dev/block/{os.major(root_identity.st_dev)}:{os.minor(root_identity.st_dev)}")
    approved = os.path.realpath(f"/sys/dev/block/{device}")
    if not os.path.exists(actual) or not os.path.exists(approved) or not (actual == approved or actual.startswith(approved + "/")):
        raise ValueError("QUANT_IO_STORAGE_DEVICE_MISMATCH")
    with open("/proc/self/cgroup", encoding="ascii") as source:
        groups = [line[3:].strip() for line in source if line.startswith("0::")]
    if len(groups) != 1 or not groups[0].startswith("/") or any(part in (".", "..") for part in groups[0].split("/")):
        raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
    location = os.path.join("/sys/fs/cgroup", groups[0].lstrip("/"))
    identity = os.stat(location).st_ino

    def limits():
        if os.stat(location).st_ino != identity:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        maximum = _fields(location, "io.max", device)
        if maximum.get("rbps") != rbps or maximum.get("wbps") != wbps:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")

    deadline = time.monotonic() + 2
    limits()
    descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        block = b"Q" * 4096
        if os.write(descriptor, block) != len(block):
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    while time.monotonic() < deadline:
        limits()
        try:
            counters = _fields(location, "io.stat", device)
        except ValueError:
            counters = {}
        if counters.get("rbytes", "").isdecimal() and counters.get("wbytes", "").isdecimal() and time.monotonic() < deadline:
            return
        time.sleep(0.025)
    raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")


def main(prepare=prepare_io_telemetry, input_stream=None, sleeper=time.sleep):
    prepare()
    stream = input_stream if input_stream is not None else sys.stdin.buffer
    if stream.readline(len(PAYLOAD) + 1) != PAYLOAD or stream.read(1):
        raise ValueError("INVALID_QUANT_PROCESS_PAYLOAD")
    sys.stdout.buffer.write(ACCEPTED)
    sys.stdout.buffer.flush()
    sleeper(60)


if __name__ == "__main__":
    main()
