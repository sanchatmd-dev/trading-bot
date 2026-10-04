"""Node research CATALOG and Python custom evaluator CATALOG must declare the same ten inputs.

src/quant-research/contract.js gates what the optimizer lock accepts; the Python
evaluator gates what it can simulate. A silent drift in a name, a bound or an
int flag would let one side accept an input the other side mishandles.
"""
import re
from decimal import Decimal
from pathlib import Path

from robot_quant.spt_custom_evaluator import CATALOG as PY_CATALOG
from robot_quant.spt_evaluator import SOURCE_HASH as PY_SOURCE_HASH

CONTRACT_JS = Path(__file__).resolve().parents[2] / "src" / "quant-research" / "contract.js"
NUMBER = "([0-9]*[.]?[0-9]+)"
ENTRY = re.compile("([A-Za-z_][A-Za-z0-9_]*):" + re.escape("[") + NUMBER + "," + NUMBER + ",(true|false)" + re.escape("]"))


def js_catalog():
    """Parse `export const CATALOG={name:[min,max,isInt],...};` from the contract source."""
    text = CONTRACT_JS.read_text(encoding="utf-8")
    start = text.index("export const CATALOG=")
    body = "".join(text[start:text.index("};", start) + 1].split())
    entries = ENTRY.findall(body)
    # Every `:[` in the literal must have been parsed: a new syntax must fail loudly here.
    assert len(entries) == body.count(":["), "CATALOG literal has an entry this parser does not understand"
    names = [name for name, *_ in entries]
    assert len(names) == len(set(names)), "duplicate CATALOG name in contract.js"
    return {name: (Decimal(low), Decimal(high), flag == "true") for name, low, high, flag in entries}


def test_js_catalog_literal_is_parsed_completely():
    parsed = js_catalog()
    assert len(parsed) == 10
    assert all(low < high for low, high, _ in parsed.values())


def test_catalog_names_match_in_order():
    assert list(js_catalog()) == list(PY_CATALOG)


def test_catalog_bounds_match():
    parsed = js_catalog()
    for name, (_, _, low, high) in PY_CATALOG.items():
        assert parsed[name][0] == Decimal(str(low)), name + " min"
        assert parsed[name][1] == Decimal(str(high)), name + " max"


def test_catalog_int_flags_match():
    parsed = js_catalog()
    for name, (_, kind, _, _) in PY_CATALOG.items():
        assert kind in (int, float), name
        assert parsed[name][2] is (kind is int), name + " int flag"


def test_supported_source_hash_matches():
    text = CONTRACT_JS.read_text(encoding="utf-8")
    match = re.search(r"export const SOURCE_HASH='([0-9a-f]{64})'", text)
    assert match, "SOURCE_HASH literal not found in contract.js"
    assert match.group(1) == PY_SOURCE_HASH
