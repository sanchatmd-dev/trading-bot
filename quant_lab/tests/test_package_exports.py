"""The never-executed TYPE_CHECKING imports in robot_quant/__init__.py mirror the lazy export map.

The Node engine-hash closure walkers (test/preflight-resolver.test.js, test/quant-engine-files.test.js)
read static ``from robot_quant.<module> import`` lines. The lazy ``__getattr__`` loads modules with
``import_module``, so the TYPE_CHECKING block is the only static record of those modules. It must
list exactly the modules and names of ``_EXPORT_GROUPS``, in order, or the closures drift.
"""

import ast
import re
import subprocess
import sys
from pathlib import Path

import robot_quant


def type_checking_block(tree):
    blocks = [node for node in tree.body if isinstance(node, ast.If)
              and isinstance(node.test, ast.Name) and node.test.id == "TYPE_CHECKING"]
    assert len(blocks) == 1, "exactly one top-level `if TYPE_CHECKING:` block"
    assert not blocks[0].orelse
    return blocks[0]


def test_type_checking_imports_equal_the_lazy_export_map():
    source = Path(robot_quant.__file__).read_text(encoding="utf-8")
    tree = ast.parse(source)
    # TYPE_CHECKING is typing's constant, so the block never runs at import time.
    assert any(isinstance(node, ast.ImportFrom) and node.module == "typing"
               and any(alias.name == "TYPE_CHECKING" and alias.asname is None for alias in node.names)
               for node in tree.body)
    block = type_checking_block(tree)
    assert all(isinstance(node, ast.ImportFrom) for node in block.body)
    static = {}
    for node in block.body:
        assert node.level == 0 and node.module.startswith("robot_quant."), "absolute robot_quant imports only"
        assert all(alias.asname is None for alias in node.names)
        module = node.module.removeprefix("robot_quant.")
        assert module not in static, f"{module} imported twice"
        static[module] = tuple(alias.name for alias in node.names)
    assert static == robot_quant._EXPORT_GROUPS
    assert sorted(name for names in static.values() for name in names) == sorted(robot_quant.__all__)
    # The same pattern the PF-2 closure walker uses must see every lazily exported module.
    walked = set(re.findall(r"^\s*from\s+robot_quant\.(\w+)\s+import", source, re.M))
    assert walked == set(robot_quant._EXPORT_GROUPS)


def test_type_checking_block_is_not_executed_at_import():
    script = ("import sys, robot_quant\n"
              "assert not any(name.startswith('robot_quant.') for name in sys.modules)\n"
              "assert not any(name in vars(robot_quant) for name in robot_quant.__all__)\n")
    child = subprocess.run([sys.executable, "-c", script], capture_output=True, timeout=120)
    assert child.returncode == 0, child.stderr.decode()