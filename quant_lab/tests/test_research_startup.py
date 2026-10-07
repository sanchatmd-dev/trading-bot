"""Cold process ordering and post-readiness failure checks on synthetic I/O."""

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
PROBE = "quant_lab.tests.research_startup_probe"
HEAVY = ("robot_quant.bridge_replay", "robot_quant.paper_state", "robot_quant.spt_custom_evaluator")


def environment(tmp_path, mode):
    source = os.environ.get("QUANT_TEST_SOURCE", str(ROOT / "quant_lab/src"))
    return {**os.environ, "PYTHONPATH": os.pathsep.join((source, str(ROOT))),
            "QUANT_TEST_STARTUP_EVENTS": str(tmp_path / "events.jsonl"),
            "QUANT_TEST_STARTUP_MODE": mode,
            "OMP_NUM_THREADS": "1", "OPENBLAS_NUM_THREADS": "1", "MKL_NUM_THREADS": "1"}


def events(tmp_path):
    return [json.loads(line) for line in (tmp_path / "events.jsonl").read_text().splitlines()]


def test_readiness_precedes_evaluation_imports_in_fresh_process(tmp_path):
    child = subprocess.run([sys.executable, "-m", PROBE], cwd=ROOT,
                           env=environment(tmp_path, "ready_only"), capture_output=True, timeout=120)
    assert child.returncode == 0, child.stderr.decode()
    assert child.stdout == b""
    observed = events(tmp_path)
    assert [event["event"] for event in observed] == ["scratch_created", "ready"]


@pytest.mark.parametrize("module", HEAVY)
def test_import_failure_after_ready_has_no_partial_result(tmp_path, module):
    child = subprocess.run([sys.executable, "-m", PROBE], cwd=ROOT,
                           env=environment(tmp_path, "fail:" + module), input=b"{}\n",
                           capture_output=True, timeout=120)
    assert child.returncode == 1
    assert child.stdout == b""
    assert b"INJECTED_HEAVY_IMPORT_FAILURE" in child.stderr
    observed = events(tmp_path)
    assert [event["event"] for event in observed[:2]] == ["scratch_created", "ready"]
    assert observed[-1]["module"] == module
    assert all(event["ready"] for event in observed if event["event"] == "evaluation_import")


@pytest.mark.skipif(sys.platform != "win32", reason="Local supervisor mode; Linux requires an authorized systemd host")
def test_supervisor_rejects_import_failure_after_ready(tmp_path):
    node = shutil.which("node")
    assert node is not None, "Node is required for the supervisor acceptance check"
    script = """
        import {runQuantProcess} from './src/quant-research/process-supervisor.js';
        try {
          const result = await runQuantProcess({payload:{}, python:process.env.QUANT_TEST_PYTHON,
            module:'quant_lab.tests.research_startup_probe',allowUnsupportedPlatformForTests:true});
          console.log(JSON.stringify({accepted:true,result}));
        } catch(error) {
          console.log(JSON.stringify({accepted:false,code:error.code,stopped:error.stopped}));
        }
    """
    env = environment(tmp_path, "fail:robot_quant.bridge_replay")
    env["QUANT_TEST_PYTHON"] = sys.executable
    child = subprocess.run([node, "--input-type=module", "-e", script], cwd=ROOT,
                           env=env, capture_output=True, timeout=40)
    assert child.returncode == 0, child.stderr.decode()
    assert json.loads(child.stdout) == {"accepted": False, "code": "EVALUATION_FAILED", "stopped": True}
    assert [event["event"] for event in events(tmp_path)[:2]] == ["scratch_created", "ready"]


def test_package_exports_remain_available_without_eager_data_imports():
    script = """
import importlib
import sys
import robot_quant
assert not any(name in sys.modules for name in ('pandas', 'pyarrow', 'duckdb', 'pydantic'))
assert not any(name.startswith('robot_quant.') for name in sys.modules)
assert robot_quant.__version__ == '0.3.0'
assert set(robot_quant.__all__) <= set(dir(robot_quant))
for name in robot_quant.__all__:
    value = getattr(robot_quant, name)
    assert value is getattr(importlib.import_module(value.__module__), name)
    assert getattr(robot_quant, name) is value
namespace = {}
exec('from robot_quant import *', namespace)
assert set(namespace) - {'__builtins__'} == set(robot_quant.__all__)
try:
    robot_quant.unknown_export
except AttributeError:
    pass
else:
    raise AssertionError('unknown export did not raise AttributeError')
from robot_quant import research_chunk
assert callable(research_chunk.evaluate_chunk)
"""
    child = subprocess.run([sys.executable, "-c", script], cwd=ROOT, capture_output=True, timeout=120)
    assert child.returncode == 0, child.stderr.decode()
