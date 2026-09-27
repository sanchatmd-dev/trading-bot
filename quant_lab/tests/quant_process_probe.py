"""Synthetic supervisor fixture; never evaluates market or owner data."""
import json
import os
import pathlib
import subprocess
import sys
import time

request = json.load(sys.stdin)
mode = request.get("mode", "ok")
if mode == "sleep":
    time.sleep(60)
elif mode == "output":
    print("x" * (3 * 1024 * 1024))
elif mode == "memory":
    memory = bytearray(700 * 1024 * 1024)
    print(json.dumps({"bytes": len(memory)}))
elif mode == "descendant":
    child = subprocess.Popen([sys.executable, "-c", "import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    if request.get("pid_path"):
        pathlib.Path(request["pid_path"]).write_text(str(child.pid))
    time.sleep(0.1)
    print(json.dumps({"child_pid": child.pid}))
else:
    result = {"ok": True, "pid": os.getpid(), "thread_limit": os.environ.get("OMP_NUM_THREADS")}
    if sys.platform == "linux":
        location = pathlib.Path("/sys/fs/cgroup") / pathlib.Path("/proc/self/cgroup").read_text().strip().split("::", 1)[1].lstrip("/")
        result["limits"] = {name: (location / name).read_text().strip() for name in ("cpu.max", "memory.max", "pids.max")}
    print(json.dumps(result))
