import json
from pathlib import Path


def test_notebooks_have_no_committed_outputs():
    root = Path(__file__).resolve().parents[1]
    for path in (root / "notebooks").rglob("*.ipynb"):
        notebook = json.loads(path.read_text(encoding="utf-8"))
        for cell in notebook.get("cells", []):
            assert not cell.get("outputs"), f"Strip outputs: {path}"
            assert cell.get("execution_count") is None, f"Strip execution counts: {path}"
