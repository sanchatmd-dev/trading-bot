"""Combined multi-Pine job (RD-MP-28): protocol, membership projection, codes, holdout rows.

Most tests run the UNCHANGED source gate ``validate_custom_snapshot`` against a synthetic source:
the module constant ``SOURCE_HASH`` is monkeypatched to the hash of a dummy source text and a
58-input analysis is built in the test. That proves the job mechanics and the projection against
the real gate code, and nothing about the reviewed SPT source. The tests that need the real
reviewed source and the two private analyses read them from the ignored directory named by
``MP_PRIVATE_INPUTS_DIR`` and are SKIPPED without it (reported as not run) unless
``MP_REQUIRE_PRIVATE=1``, which makes their absence a failure.
"""

import copy
import hashlib
import json
import os
import re
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest

from robot_quant import mp_combined_job as job
from robot_quant import spt_custom_evaluator as gate
from robot_quant.mp_combined_paper import BridgePair, MemberSignals, combined_paper_replay
from robot_quant.ql3a import canonical, mark_period
from robot_quant.spt_custom_evaluator import (
    CustomSignalInputs,
    evaluate_bars,
    validate_custom_snapshot,
)
from robot_quant.spt_evaluator import REQUIRED_SETTINGS
from robot_quant.spt_evaluator import SOURCE_HASH as REVIEWED_SOURCE_HASH

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "test" / "fixtures" / "mp-combined"
SRC = ROOT / "quant_lab" / "src"
DUMMY_SOURCE = "// synthetic fixture source: NOT the reviewed SPT source\nstrategy('fixture')\n"
DUMMY_HASH = hashlib.sha256(DUMMY_SOURCE.encode()).hexdigest()


def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


# ------------------------------------------------------------------------ builders (no private data)


@pytest.fixture(scope="module")
def manifest():
    return json.loads((FIXTURES / "manifest.json").read_text())


@pytest.fixture(scope="module")
def rows():
    return json.loads((FIXTURES / "bars-v1.json").read_text())["bars"]


@pytest.fixture
def synthetic_gate(monkeypatch):
    """The unchanged gate, bound to the dummy source instead of the reviewed one."""
    monkeypatch.setattr(gate, "SOURCE_HASH", DUMMY_HASH)
    return DUMMY_HASH


def analysis_for(values: dict, source_hash: str) -> dict:
    """A 58-input analysis: the 10 catalog inputs, the 11 fixed Custom settings and 37 filler inputs."""
    settings = {**{k: v for k, v in REQUIRED_SETTINGS.items() if k != "confirmLookback"}, "preset": "Custom"}
    named = [*values.items(), *settings.items()]
    inputs = [
        {"input_id": f"in{i:02d}", "pine_variable": name, "effective_value": value,
         "declared_domain": {"min": None, "max": None}}
        for i, (name, value) in enumerate(named)
    ]
    inputs += [
        {"input_id": f"in{i:02d}", "pine_variable": f"filler{i}", "effective_value": i,
         "declared_domain": {"min": None, "max": None}}
        for i in range(len(named), 58)
    ]
    effective = digest(inputs)
    return {
        "inputs": inputs, "effective_inputs_hash": effective,
        "effective_input_review": {
            "source_hash": source_hash, "effective_inputs_hash": effective, "input_count": 58,
            "reviewed_by": "fixture", "reviewed_at": 1,
        },
    }


def member_record(ordinal, name, analysis, source_hash, source, *, deployment_id=None):
    return {
        "ordinal": ordinal, "deployment_id": deployment_id or f"fixture-{name.lower()}-{ordinal}",
        "pine_import_id": f"pine-{ordinal}", "source_version": 1, "source_hash": source_hash,
        "effective_inputs_hash": analysis["effective_inputs_hash"], "source": source, "analysis": analysis,
    }


def build_members(records):
    """Add each member's deployment snapshot: ALL members in `membership`, as member-set.js writes it."""
    membership = [
        {"pine_import_id": r["pine_import_id"], "source_version": r["source_version"],
         "source_hash": r["source_hash"], "analysis": r["analysis"]}
        for r in records
    ]
    result = []
    for r in records:
        snapshot = {
            "source_hash": r["source_hash"],
            "market": {"broker": "binance-global", "symbol": "BTCUSDT", "timeframe": "1"},
            "selection": {
                "bindings": [],
                "fixed_inputs": copy.deepcopy(r["analysis"]["inputs"]),
                "signals": {"buy": "buySignal", "exit": "sellSignal", "timing": "bar_close"},
            },
            "membership": copy.deepcopy(membership),
        }
        member = {k: v for k, v in r.items() if k != "analysis"}
        result.append({**member, "snapshot": snapshot})
    return result


def synthetic_members(manifest, names=("M1", "M2"), extra=None):
    records = []
    for index, name in enumerate(names):
        values = extra[index] if extra and extra[index] is not None else manifest["members"][name]["inputs"]
        records.append(member_record(index + 1, name, analysis_for(values, DUMMY_HASH), DUMMY_HASH, DUMMY_SOURCE))
    return build_members(records)


def make_request(manifest, rows, members, *, kind="CANDIDATE", pair=None):
    split = manifest["split"]
    end = split["test_end"] if kind == "HOLDOUT" else split["validation_end"]
    return {
        "version": job.REQUEST_VERSION, "evaluator": job.EVALUATOR, "closure": job.CLOSURE,
        "run": {"run_id": "run-1", "contract_hash": "c" * 64, "engine_hash": "e" * 64, "set_hash": "s" * 64},
        "market": dict(manifest["market"]),
        "model": dict(manifest["model"]),
        "policy": dict(manifest["policy"]),
        "capital": dict(manifest["capital"]),
        "split": dict(split),
        "first_time": manifest["bars"]["first_time"],
        "same_bar_order": manifest["same_bar_order"],
        "members": members,
        "rows": rows[:end],
        "step": {"kind": kind, "pair": dict(pair or manifest["pair"])},
    }


def library_ledger(manifest, rows, members_signals, deployment_ids, *, pair=None, factor=1):
    from robot_quant.bridge_replay import BridgeBar, PaperModel

    m = manifest["model"]
    bars = [BridgeBar(r["time"], *(Decimal(r[k]) for k in ("open", "high", "low", "close", "volume")), Decimal(r["atr14"])) for r in rows]
    raw = pair or manifest["pair"]
    return combined_paper_replay(
        [MemberSignals(i + 1, dep, sig) for i, (dep, sig) in enumerate(zip(deployment_ids, members_signals, strict=True))],
        bars, BridgePair(Decimal(raw["atr_multiplier"]), Decimal(raw["rr"])),
        model=PaperModel(Decimal(m["price_tick"]), Decimal(m["quantity_step"]), Decimal(m["fee_bps"]) * factor,
                         Decimal(m["slippage_bps"]) * factor, Decimal(m["risk_percent"])),
        policy=manifest["policy"], equity=Decimal(manifest["capital"]["equity"]), cash=Decimal(manifest["capital"]["cash"]),
        broker="binance-global", symbol="BTCUSDT", start_time=rows[manifest["split"]["warmup"]]["time"],
        same_bar_order=manifest["same_bar_order"],
    )


def signals_of(manifest, rows, name):
    inputs = CustomSignalInputs.from_source_values(manifest["members"][name]["inputs"])
    return tuple((e.buy, e.native_exit) for e in evaluate_bars(rows, inputs))


def code_of(call):
    with pytest.raises(ValueError) as caught:
        call()
    return str(caught.value)


# ------------------------------------------------------------ projection (function level, no gate)


def test_projection_keeps_only_the_members_own_row_and_does_not_mutate_the_input(manifest):
    members = synthetic_members(manifest)
    original = copy.deepcopy(members[1]["snapshot"])
    projected = job.project_membership(members[1]["snapshot"], members[1])
    assert members[1]["snapshot"] == original  # input untouched
    assert len(original["membership"]) == 2  # a member snapshot lists every connected member
    assert [row["pine_import_id"] for row in projected["membership"]] == ["pine-2"]
    assert projected["membership"][0]["analysis"]["effective_inputs_hash"] == members[1]["effective_inputs_hash"]
    assert {k: v for k, v in projected.items() if k != "membership"} == {k: v for k, v in original.items() if k != "membership"}


def test_projection_refuses_zero_or_two_matching_rows_and_foreign_hashes(manifest):
    members = synthetic_members(manifest)
    member, snapshot = members[1], members[1]["snapshot"]
    for bad_rows in (
        [snapshot["membership"][0]],  # zero rows for pine-2
        [snapshot["membership"][1], dict(snapshot["membership"][1])],  # two rows for pine-2
        [],
    ):
        assert code_of(lambda r=bad_rows: job.project_membership({**snapshot, "membership": r}, member)) == "MP_INPUT_INVALID"
    wrong_version = {**member, "source_version": 2}
    assert code_of(lambda: job.project_membership(snapshot, wrong_version)) == "MP_INPUT_INVALID"
    wrong_source = {**member, "source_hash": "f" * 64}
    assert code_of(lambda: job.project_membership(snapshot, wrong_source)) == "MP_INPUT_INVALID"
    wrong_inputs = {**member, "effective_inputs_hash": "f" * 64}
    assert code_of(lambda: job.project_membership(snapshot, wrong_inputs)) == "MP_INPUT_INVALID"
    for broken in (None, {}, {"membership": "x"}, {"membership": [None, 1]}):
        assert code_of(lambda b=broken: job.project_membership(b, member)) == "MP_INPUT_INVALID"


def test_projection_matches_by_import_and_version_not_by_source_hash(manifest):
    """Option A: both rows share one source hash, so a hash match would pick the first row for member 2."""
    members = synthetic_members(manifest)
    assert members[0]["source_hash"] == members[1]["source_hash"]
    assert members[0]["effective_inputs_hash"] != members[1]["effective_inputs_hash"]
    for index in (0, 1):
        projected = job.project_membership(members[index]["snapshot"], members[index])
        assert projected["membership"][0]["pine_import_id"] == f"pine-{index + 1}"


# ------------------------------------- the projection against the UNCHANGED gate (synthetic source)


def test_gate_refuses_member_two_without_the_projection_and_accepts_it_with_the_projection(manifest, synthetic_gate):
    members = synthetic_members(manifest)
    source = DUMMY_SOURCE.encode()
    inputs_one, selected = validate_custom_snapshot(source, members[0]["snapshot"])
    assert selected == [] and inputs_one == CustomSignalInputs()
    # unprojected: the gate takes the FIRST row of the shared source hash and compares member 2's values with member 1's analysis
    assert code_of(lambda: validate_custom_snapshot(source, members[1]["snapshot"])) == "CUSTOM_EFFECTIVE_INPUT_CHANGED"
    projected = job.project_membership(members[1]["snapshot"], members[1])
    inputs_two, selected = validate_custom_snapshot(source, projected)
    assert selected == [] and inputs_two == CustomSignalInputs.from_source_values(manifest["members"]["M2"]["inputs"])
    assert job.member_inputs(members[0]) == inputs_one and job.member_inputs(members[1]) == inputs_two


def test_member_inputs_runs_the_gate_unchanged_and_its_refusals_stay_the_gates(manifest, synthetic_gate):
    members = synthetic_members(manifest)
    wrong_source = {**members[0], "source": DUMMY_SOURCE + "// edited\n"}
    assert code_of(lambda: job.member_inputs(wrong_source)) == "UNSUPPORTED_SOURCE_HASH"
    changed = copy.deepcopy(members[1])
    changed["snapshot"]["selection"]["fixed_inputs"][0]["effective_value"] = 99
    assert code_of(lambda: job.member_inputs(changed)) == "CUSTOM_EFFECTIVE_INPUT_CHANGED"
    unreviewed = copy.deepcopy(members[0])
    del unreviewed["snapshot"]["membership"][0]["analysis"]["effective_input_review"]
    assert code_of(lambda: job.member_inputs(unreviewed)) == "CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED"
    bad_market = copy.deepcopy(members[0])
    bad_market["snapshot"]["market"]["symbol"] = "ETHUSDT"
    assert code_of(lambda: job.member_inputs(bad_market)) == "UNSUPPORTED_CUSTOM_MARKET"
    bad_setting = copy.deepcopy(members[0])
    row = next(r for r in bad_setting["snapshot"]["selection"]["fixed_inputs"] if r["pine_variable"] == "useMTF")
    row["effective_value"] = True
    bad_setting["snapshot"]["membership"][0]["analysis"]["inputs"] = bad_setting["snapshot"]["selection"]["fixed_inputs"]
    assert code_of(lambda: job.member_inputs(bad_setting)).startswith("UNSUPPORTED_CUSTOM_SETTING")


def test_source_slots_are_forbidden_before_the_gate_runs(manifest):
    members = synthetic_members(manifest)  # no synthetic_gate: the refusal comes first, no source is needed
    members[0]["snapshot"]["selection"]["bindings"] = [{"pine_variable": "emaFastInput", "slot": 3}]
    assert code_of(lambda: job.member_inputs(members[0])) == "MP_SOURCE_SLOTS_FORBIDDEN"
    broken = copy.deepcopy(members[1])
    broken["snapshot"]["selection"]["bindings"] = "x"
    assert code_of(lambda: job.member_inputs(broken)) == "MP_INPUT_INVALID"
    del broken["snapshot"]["selection"]
    assert code_of(lambda: job.member_inputs(broken)) == "MP_INPUT_INVALID"


# ------------------------------------------------------------------------- protocol (no gate needed)


def test_request_keys_are_closed_at_every_level(manifest, rows):
    members = synthetic_members(manifest)
    good = make_request(manifest, rows, members)
    paths = [
        ("extra",), ("run", "extra"), ("market", "extra"), ("model", "extra"), ("capital", "extra"),
        ("split", "extra"), ("step", "extra"), ("step", "pair", "extra"), ("members", 0, "extra"), ("rows", 0, "extra"),
        ("members", 0, "pair"), ("members", 1, "atr_multiplier"), ("step", "pair", "member_pairs"),
    ]
    for path in paths:
        bad = copy.deepcopy(good)
        target = bad
        for key in path[:-1]:
            target = target[key]
        target[path[-1]] = "x"
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", path
    for key in list(good):
        bad = {k: v for k, v in good.items() if k != key}
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", key


def test_scalar_fields_are_checked(manifest, rows):
    members = synthetic_members(manifest)
    good = make_request(manifest, rows, members)
    changes = [
        ("version", "mp-combined-request-v0"), ("evaluator", "other"), ("closure", "other"),
        ("market", {"broker": "binance-global", "symbol": "ETHUSDT", "timeframe": "1"}),
        ("market", {"broker": "binance-global", "symbol": "BTCUSDT", "timeframe": "5"}),
        ("first_time", good["first_time"] + 1), ("first_time", True), ("first_time", "1"),
        ("capital", {"equity": "0", "cash": "100"}), ("capital", {"equity": 100, "cash": "100"}),
        ("capital", {"equity": "1e3", "cash": "100"}), ("capital", {"equity": "-1", "cash": "100"}),
        ("split", {**good["split"], "warmup": 0}), ("split", {**good["split"], "train_end": good["split"]["warmup"]}),
        ("split", {**good["split"], "test_end": 10001}), ("split", {**good["split"], "warmup": True}),
        ("model", {**good["model"], "fee_bps": 10}), ("model", {**good["model"], "fee_bps": "NaN"}),
        ("policy", {k: v for k, v in good["policy"].items() if k != "killSwitch"}), ("policy", []),
        ("step", {"kind": "BASELINE", "pair": good["step"]["pair"]}),
        ("step", {"kind": "CANDIDATE", "pair": {"atr_multiplier": "0", "rr": "1"}}),
        ("step", {"kind": "CANDIDATE", "pair": {"atr_multiplier": "2", "rr": "-1"}}),
        ("step", {"kind": "CANDIDATE", "pair": {"atr_multiplier": 2, "rr": "1"}}),
        ("step", {"kind": "CANDIDATE", "pair": [("atr_multiplier", "2"), ("rr", "1")]}),
        ("run", {**good["run"], "run_id": ""}), ("run", {**good["run"], "set_hash": 1}),
    ]
    for key, value in changes:
        bad = {**good, key: value}
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", (key, value)
    assert code_of(lambda: job.evaluate_request([])) == "MP_INPUT_INVALID"
    assert code_of(lambda: job.evaluate_request(None)) == "MP_INPUT_INVALID"


def test_member_list_rules(manifest, rows):
    members = synthetic_members(manifest, ("M1", "M2", "M1"), extra=[None, None, {**manifest["members"]["M1"]["inputs"], "emaFastInput": 21}])
    good = make_request(manifest, rows, members)
    for count in (0, 1, 4):
        bad = {**good, "members": (members * 2)[:count]}
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", count
    swapped = {**good, "members": [members[1], members[0], members[2]]}
    assert code_of(lambda: job.evaluate_request(swapped)) == "MP_INPUT_INVALID"
    same_deployment = copy.deepcopy(good)
    same_deployment["members"][1]["deployment_id"] = same_deployment["members"][0]["deployment_id"]
    assert code_of(lambda: job.evaluate_request(same_deployment)) == "MP_INPUT_INVALID"
    same_import = copy.deepcopy(good)
    same_import["members"][1]["pine_import_id"] = same_import["members"][0]["pine_import_id"]
    assert code_of(lambda: job.evaluate_request(same_import)) == "MP_INPUT_INVALID"
    wrong_ordinal = copy.deepcopy(good)
    wrong_ordinal["members"][1]["ordinal"] = 3
    assert code_of(lambda: job.evaluate_request(wrong_ordinal)) == "MP_INPUT_INVALID"
    bad_hash = copy.deepcopy(good)
    bad_hash["members"][0]["source_hash"] = "ABC"
    assert code_of(lambda: job.evaluate_request(bad_hash)) == "MP_INPUT_INVALID"


def test_equal_source_and_input_hashes_are_duplicate_logic(manifest, rows):
    members = synthetic_members(manifest, ("M1", "M1"))
    assert members[0]["effective_inputs_hash"] == members[1]["effective_inputs_hash"]
    assert code_of(lambda: job.evaluate_request(make_request(manifest, rows, members))) == "MP_MEMBER_DUPLICATE_LOGIC"


def test_holdout_rows_reach_the_process_only_in_a_holdout_step(manifest, rows):
    members = synthetic_members(manifest)
    split = manifest["split"]
    candidate = make_request(manifest, rows, members)
    assert len(candidate["rows"]) == split["validation_end"]
    for kind in ("CANDIDATE", "SENSITIVITY", "STRESS"):
        too_long = {**make_request(manifest, rows, members, kind=kind), "rows": rows[: split["test_end"]]}
        assert code_of(lambda r=too_long: job.evaluate_request(r)) == "MP_INPUT_INVALID", kind
    holdout = make_request(manifest, rows, members, kind="HOLDOUT")
    assert len(holdout["rows"]) == split["test_end"]
    too_short = {**holdout, "rows": rows[: split["validation_end"]]}
    assert code_of(lambda: job.evaluate_request(too_short)) == "MP_INPUT_INVALID"


def test_rows_must_be_contiguous_closed_decimal_strings(manifest, rows):
    members = synthetic_members(manifest)
    good = make_request(manifest, rows, members)
    gap = copy.deepcopy(good)
    gap["rows"][10]["time"] += 60000
    for index in (10, 0):
        bad = copy.deepcopy(good)
        bad["rows"][index]["time"] -= 60000
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID"
    assert code_of(lambda: job.evaluate_request(gap)) == "MP_INPUT_INVALID"
    for field, value in (("open", 31000.5), ("atr14", None), ("close", "1e3"), ("volume", "-1"), ("high", True)):
        bad = copy.deepcopy(good)
        bad["rows"][5][field] = value
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", field


def test_error_codes_are_short_upper_case_and_never_carry_a_message():
    code = job._error_code
    assert code(ValueError("CUSTOM_EFFECTIVE_INPUT_CHANGED")) == "CUSTOM_EFFECTIVE_INPUT_CHANGED"
    assert code(ValueError("UNSUPPORTED_CUSTOM_SETTING:useMTF")) == "UNSUPPORTED_CUSTOM_SETTING"
    assert code(ValueError("MP_CROSS_SOURCE_TARGET")) == "MP_CROSS_SOURCE_TARGET"
    assert code(ValueError("MP_EVENT_ORDER_UNDEFINED")) == "MP_EVENT_ORDER_UNDEFINED"
    assert code(ValueError("INVALID_EXECUTION_MODEL")) == "MP_INPUT_INVALID"
    for hostile in (ValueError("/home/secret/path: boom"), ValueError("lower case"), ValueError(""), RuntimeError("x"),
                    ValueError("NEGATIVE_SPOT_LEDGER"), ValueError("A" * 80), OSError("x"), MemoryError()):
        assert code(hostile) == "EVALUATION_FAILED"
    for error in (KeyError("k"), TypeError("t"), AttributeError("a"), RecursionError()):
        assert code(error) == "MP_INPUT_INVALID"
    shape = re.compile(r"[A-Z][A-Z0-9_]{1,63}")
    for emitted in (job.INPUT_INVALID, job.SOURCE_SLOTS_FORBIDDEN, job.DUPLICATE_LOGIC, job.OUTPUT_TOO_LARGE, job.FAILED,
                    *job._GATE_CODES, *job._LIBRARY_CODES):
        assert shape.fullmatch(emitted), emitted


# ---------------------------------------------------- end to end through the unchanged gate (synthetic)


def run_job(manifest, rows, members, **kwargs):
    return job.evaluate_request(make_request(manifest, rows, members, **kwargs))


def test_candidate_step_equals_the_library_run_on_the_same_signals(manifest, rows, synthetic_gate):
    members = synthetic_members(manifest)
    result = run_job(manifest, rows, members)
    split = manifest["split"]
    assert result["version"] == "mp-combined-step-v1" and result["kind"] == "CANDIDATE"
    assert result["run"] == make_request(manifest, rows, members)["run"]
    assert result["owner_recommendation_ready"] is False and "test" not in result and "ledger" not in result
    assert set(result) == {
        "version", "evaluator", "closure", "run", "kind", "pair", "same_bar_order", "train", "validation",
        "decision_count", "fills", "rejections", "exit_fill_reasons", "diagnostics", "member_signals",
        "ledger_hash", "owner_recommendation_ready",
    }
    sigs = [signals_of(manifest, rows, "M1"), signals_of(manifest, rows, "M2")]
    sub = rows[: split["validation_end"]]
    library = library_ledger(manifest, sub, [s[: split["validation_end"]] for s in sigs], ["fixture-m1-1", "fixture-m2-2"])
    ledger = library["ledger"]
    assert result["ledger_hash"] == digest(ledger)
    assert result["diagnostics"] == library["diagnostics"]
    assert result["decision_count"] == len(ledger["decisions"]) and result["fills"] == len(ledger["fills"])
    from robot_quant.bridge_replay import BridgeBar

    marked = [(BridgeBar(r["time"], *(Decimal(r[k]) for k in ("open", "high", "low", "close", "volume")), Decimal(r["atr14"])), False, False) for r in sub]
    cash = Decimal(manifest["capital"]["cash"])
    assert result["train"] == mark_period(marked, ledger["fills"], split["warmup"], split["train_end"], cash)
    assert result["validation"] == mark_period(marked, ledger["fills"], split["train_end"], split["validation_end"], cash)
    assert result["diagnostics"]["cross_source_target"] == 0 and result["diagnostics"]["duplicate_intents"] == 0
    json.dumps(result, allow_nan=False)


def test_member_signals_report_hash_and_native_counts_per_segment(manifest, rows, synthetic_gate):
    result = run_job(manifest, rows, synthetic_members(manifest))
    pinned = manifest["native_counts"]
    for entry, name in zip(result["member_signals"], ("M1", "M2"), strict=True):
        assert set(entry) == {"ordinal", "deployment_id", "signals_hash", "native_buy", "native_exit", "segments"}
        assert entry["segments"] == {"train": pinned[name]["train"], "validation": pinned[name]["validation"]}
        assert entry["native_buy"] == pinned[name]["train"]["buy"] + pinned[name]["validation"]["buy"]
        assert entry["native_exit"] == pinned[name]["train"]["exit"] + pinned[name]["validation"]["exit"]
        assert re.fullmatch(r"[0-9a-f]{64}", entry["signals_hash"])
    assert result["member_signals"][0]["signals_hash"] != result["member_signals"][1]["signals_hash"]


def test_holdout_step_carries_test_metrics_trace_and_signal_vectors(manifest, rows, synthetic_gate):
    members = synthetic_members(manifest)
    candidate = run_job(manifest, rows, members)
    holdout = run_job(manifest, rows, members, kind="HOLDOUT")
    split = manifest["split"]
    assert holdout["kind"] == "HOLDOUT" and "test" in holdout and holdout["test"]["bars"] == split["test_end"] - split["validation_end"]
    # causal replay: the selection part of a holdout run equals the candidate run
    assert holdout["train"] == candidate["train"] and holdout["validation"] == candidate["validation"]
    for entry, plain in zip(holdout["member_signals"], candidate["member_signals"], strict=True):
        assert entry["signals_hash"] == plain["signals_hash"]  # rows 0..validation_end in every step
        vector = entry["signals"]
        assert set(vector) == {"buy", "native_exit"}
        assert len(vector["buy"]) == len(vector["native_exit"]) == split["test_end"]
        assert all(type(v) is bool for v in vector["buy"] + vector["native_exit"])
        assert "test" in entry["segments"] and entry["segments"]["test"]["buy"] >= 15
    assert set(holdout["ledger"]) == {"events", "decisions"} and holdout["ledger"]["events"] and holdout["ledger"]["decisions"]
    # the pinned library run (all 6,000 rows) is the holdout ledger
    pinned = manifest["library_runs"][0]
    assert holdout["ledger_hash"] == pinned["ledger_sha256"]
    assert (len(holdout["ledger"]["events"]), len(holdout["ledger"]["decisions"]), holdout["fills"]) == (
        pinned["events"], pinned["decisions"], pinned["fills"])
    assert len(job._frame(holdout)) < job.RESPONSE_LIMIT


def test_stress_step_doubles_fee_and_slippage_and_pair_changes_only_the_pair(manifest, rows, synthetic_gate):
    members = synthetic_members(manifest)
    base = run_job(manifest, rows, members)
    stress = run_job(manifest, rows, members, kind="STRESS")
    assert stress["kind"] == "STRESS" and stress["ledger_hash"] != base["ledger_hash"]
    split = manifest["split"]
    sigs = [signals_of(manifest, rows, "M1")[: split["validation_end"]], signals_of(manifest, rows, "M2")[: split["validation_end"]]]
    doubled = library_ledger(manifest, rows[: split["validation_end"]], sigs, ["fixture-m1-1", "fixture-m2-2"], factor=2)
    assert stress["ledger_hash"] == digest(doubled["ledger"])
    other = run_job(manifest, rows, members, pair={"atr_multiplier": "3", "rr": "2.5"})
    assert other["pair"] == {"atr_multiplier": "3", "rr": "2.5"} and other["ledger_hash"] != base["ledger_hash"]
    # signals do not depend on the pair
    assert [m["signals_hash"] for m in other["member_signals"]] == [m["signals_hash"] for m in base["member_signals"]]


def test_f24_new_input_for_member_two_leaves_member_one_signals_byte_identical(manifest, rows, synthetic_gate):
    first = run_job(manifest, rows, synthetic_members(manifest))
    changed = {**manifest["members"]["M2"]["inputs"], "emaFastInput": 30}
    second = run_job(manifest, rows, synthetic_members(manifest, extra=[None, changed]))
    assert second["member_signals"][0] == first["member_signals"][0]
    assert second["member_signals"][1]["signals_hash"] != first["member_signals"][1]["signals_hash"]


def test_three_member_step_runs_in_ordinal_order(manifest, rows, synthetic_gate):
    third = {**manifest["members"]["M1"]["inputs"], "emaFastInput": 21, "cooldownInput": 6}
    members = synthetic_members(manifest, ("M1", "M2", "M1"), extra=[None, None, third])
    result = run_job(manifest, rows, members)
    assert [m["ordinal"] for m in result["member_signals"]] == [1, 2, 3]
    assert [m["deployment_id"] for m in result["diagnostics"]["members"]] == [m["deployment_id"] for m in members]
    assert [m["ordinal"] for m in result["diagnostics"]["members"]] == [1, 2, 3]
    assert all({"native_buy", "native_exit"} <= set(m) for m in result["diagnostics"]["members"])


def test_warmup_below_the_member_floor_is_refused(manifest, rows, synthetic_gate):
    members = synthetic_members(manifest)
    request = make_request(manifest, rows, members)
    request["split"] = {"warmup": 1249, "train_end": 4099, "validation_end": 5049, "test_end": 6000}
    request["rows"] = rows[:5049]
    assert code_of(lambda: job.evaluate_request(request)) == "MP_INPUT_INVALID"


def test_unsupported_model_version_and_order_are_refused_with_their_codes(manifest, rows, synthetic_gate):
    members = synthetic_members(manifest)
    request = make_request(manifest, rows, members)
    cost = {**request, "model": {**request["model"], "version": "paper-close-cost-v2"}}
    assert code_of(lambda: job.evaluate_request(cost)) == "MP_INPUT_INVALID"
    order = {**request, "same_bar_order": "arrival-v1"}
    assert code_of(lambda: job.evaluate_request(order)) == "MP_EVENT_ORDER_UNDEFINED"


def test_oversized_response_is_refused_with_its_code(manifest, rows, synthetic_gate, monkeypatch):
    result = run_job(manifest, rows, synthetic_members(manifest), kind="HOLDOUT")
    monkeypatch.setattr(job, "RESPONSE_LIMIT", 1000)
    assert code_of(lambda: job._frame(result)) == "EVALUATION_OUTPUT_TOO_LARGE"
    assert code_of(lambda: job._frame({"x": float("nan")})) == "EVALUATION_FAILED"


# ------------------------------------------------------------------------- real process, real gate


def spawn(payload: bytes):
    return subprocess.run(
        [sys.executable, "-I", "-m", "robot_quant.mp_combined_job"], input=payload, capture_output=True,
        env={"PYTHONPATH": str(SRC), "PATH": ""},
    )


def test_process_emits_only_a_code_for_malformed_input():
    for payload in (b"", b"not json", b"[]", b'{"version":"x"}', b'{"a":NaN}', b"\xff\xfe"):
        done = spawn(payload)
        assert done.returncode == 1 and done.stderr == b""
        assert done.stdout == b'{"error":"MP_INPUT_INVALID"}\n', payload


def test_process_refuses_an_unreviewed_source_with_the_gate_code_and_nothing_else(manifest, rows):
    members = synthetic_members(manifest)  # no patching in the child: the real reviewed hash applies
    request = make_request(manifest, rows, members)
    done = spawn(json.dumps(request).encode())
    assert done.returncode == 1 and done.stderr == b""
    assert done.stdout == b'{"error":"UNSUPPORTED_SOURCE_HASH"}\n'
    assert DUMMY_HASH != REVIEWED_SOURCE_HASH


def test_process_refuses_slots_and_oversize_input(manifest, rows):
    members = synthetic_members(manifest)
    members[1]["snapshot"]["selection"]["bindings"] = [{"pine_variable": "emaFastInput"}]
    done = spawn(json.dumps(make_request(manifest, rows, members)).encode())
    assert done.stdout == b'{"error":"MP_SOURCE_SLOTS_FORBIDDEN"}\n' and done.returncode == 1
    done = spawn(b" " * (job.REQUEST_LIMIT + 1))
    assert done.stdout == b'{"error":"MP_INPUT_INVALID"}\n' and done.returncode == 1


# --------------------------------------------------------- private reviewed inputs (skipped without)


def private_inputs(manifest):
    private = json.loads((FIXTURES / "private-inputs.manifest.json").read_text())
    directory = os.environ.get(private["directory_env"])
    wanted = {entry["role"]: entry for entry in private["files"]}
    problems = []
    found = {}
    if not directory:
        problems.append(f"{private['directory_env']} is not set")
    else:
        for role, entry in wanted.items():
            path = Path(directory) / entry["file"]
            if not path.is_file():
                problems.append(f"missing {entry['file']}")
                continue
            raw = path.read_bytes()
            if entry["sha256"] is not None and hashlib.sha256(raw).hexdigest() != entry["sha256"]:
                problems.append(f"{entry['file']} does not match the pinned SHA-256")
                continue
            found[role] = raw
    if problems:
        if os.environ.get(private["require_env"]) == "1":
            pytest.fail("private inputs required but unusable: " + "; ".join(problems))
        pytest.skip("private reviewed inputs not available (NOT RUN): " + "; ".join(problems))
    return found


def private_members(manifest, found):
    source = found["spt_source"].decode()
    records = []
    for index, role in enumerate(("analysis_m1", "analysis_m2")):
        analysis = json.loads(found[role])
        records.append(member_record(index + 1, f"M{index + 1}", analysis, REVIEWED_SOURCE_HASH, source))
    return build_members(records)


def test_private_gate_refuses_member_two_unprojected_and_accepts_it_projected(manifest):
    members = private_members(manifest, private_inputs(manifest))
    source = members[0]["source"].encode()
    validate_custom_snapshot(source, members[0]["snapshot"])
    assert members[0]["source_hash"] == members[1]["source_hash"]
    assert code_of(lambda: validate_custom_snapshot(source, members[1]["snapshot"])) == "CUSTOM_EFFECTIVE_INPUT_CHANGED"
    projected = job.project_membership(members[1]["snapshot"], members[1])
    inputs, selected = validate_custom_snapshot(source, projected)
    assert selected == [] and inputs != job.member_inputs(members[0])


def test_private_end_to_end_holdout_step(manifest, rows):
    members = private_members(manifest, private_inputs(manifest))
    result = job.evaluate_request(make_request(manifest, rows, members, kind="HOLDOUT"))
    assert result["kind"] == "HOLDOUT" and result["diagnostics"]["cross_source_target"] == 0
    reviewed = [job.member_inputs(m) for m in members]
    pinned = [CustomSignalInputs.from_source_values(manifest["members"][n]["inputs"]) for n in ("M1", "M2")]
    if reviewed == pinned:  # the private analyses carry exactly the fixture inputs: the pinned counts apply
        for entry, name in zip(result["member_signals"], ("M1", "M2"), strict=True):
            assert entry["segments"] == {s: manifest["native_counts"][name][s] for s in ("train", "validation", "test")}
        assert result["ledger_hash"] == manifest["library_runs"][0]["ledger_sha256"]


# ============================================================ S1 fix round: G5, G6, G8, N1, D8, N10


def emitted_code(call):
    """The code that would leave the process for the exception `call` raises."""
    with pytest.raises(Exception) as caught:  # noqa: B017 - any exception maps to a code
        call()
    return job._error_code(caught.value)


def segment_total(manifest, name, *segments):
    counts = manifest["native_counts"][name]
    return {kind: sum(counts[s][kind] for s in segments) for kind in ("buy", "exit")}


G5_PINS = {
    # pair -> (exit fill reasons, rejection reasons) of the candidate run over rows 0..5050, counted once from the
    # library ledger and pinned here so a changed key or a swapped Counter shows as a literal difference
    ("2", "1.5"): ({"SL": 8, "TP": 25}, {
        "BELOW_QUANTITY_STEP": 1, "TARGET_NOT_OPEN": 133, "No remaining Spot sizing budget": 87,
        "Maximum daily loss reached": 45}),
    ("6", "4"): ({"NATIVE": 21, "SL": 13, "TP": 45}, {
        "BELOW_QUANTITY_STEP": 10, "Maximum trades per day reached": 80, "TARGET_NOT_OPEN": 90}),
}


@pytest.mark.parametrize("pair", sorted(G5_PINS))
def test_g5_candidate_result_reports_exit_fill_reasons_rejections_and_the_native_funnel(
    manifest, rows, synthetic_gate, pair
):
    raw_pair = {"atr_multiplier": pair[0], "rr": pair[1]}
    result = run_job(manifest, rows, synthetic_members(manifest), pair=raw_pair)
    ledger = library_ledger(
        manifest, rows[:5050], [signals_of(manifest, rows, "M1")[:5050], signals_of(manifest, rows, "M2")[:5050]],
        ["fixture-m1-1", "fixture-m2-2"], pair=raw_pair,
    )["ledger"]
    exit_reasons, refusals = {}, {}
    for fill in ledger["fills"]:
        if fill["event_type"] == "EXIT":
            exit_reasons[fill["reason"]] = exit_reasons.get(fill["reason"], 0) + 1
    for decision in ledger["decisions"]:
        if decision["outcome"] == "REJECTED":
            refusals[decision["reason"]] = refusals.get(decision["reason"], 0) + 1
    assert result["exit_fill_reasons"] == exit_reasons and result["rejections"] == refusals
    assert (result["exit_fill_reasons"], result["rejections"]) == G5_PINS[pair]
    assert sum(refusals.values()) == result["decision_count"] - result["fills"] > 0
    # the same numbers from the diagnostics, and the fills are the BUY fills plus the EXIT fills
    bot = result["diagnostics"]["bot"]
    assert result["rejections"] == bot["rejected"] and result["exit_fill_reasons"] == bot["exit_fills"]
    assert result["fills"] == bot["accepted"] + bot["capped"] + sum(exit_reasons.values())
    # native signal funnel of each member over every row given to the step (rows 0..5050)
    for diag, name in zip(result["diagnostics"]["members"], ("M1", "M2"), strict=True):
        seen = segment_total(manifest, name, "warmup", "train", "validation")
        assert (diag["native_buy"], diag["native_exit"]) == (seen["buy"], seen["exit"])
    assert (bot["native_buy"], bot["native_exit"]) == (216, 50)  # 106 + 110 BUY, 27 + 23 exit


def test_funnel_windows_diagnostics_count_all_rows_and_member_signals_count_train_and_validation(
    manifest, rows, synthetic_gate
):
    """Root pin: diagnostics.members[] cover every row given to the step; member_signals[] cover warmup..validation_end."""
    members = synthetic_members(manifest)
    candidate = run_job(manifest, rows, members)
    holdout = run_job(manifest, rows, members, kind="HOLDOUT")
    for index, name in enumerate(("M1", "M2")):
        seen = segment_total(manifest, name, "warmup", "train", "validation")  # candidate rows 0..5050
        everything = segment_total(manifest, name, "warmup", "train", "validation", "test")  # holdout rows 0..6000
        scored = segment_total(manifest, name, "train", "validation")
        for step, expected in ((candidate, seen), (holdout, everything)):
            diag = step["diagnostics"]["members"][index]
            assert (diag["native_buy"], diag["native_exit"]) == (expected["buy"], expected["exit"]), (name, step["kind"])
            signals = step["member_signals"][index]  # train + validation in EVERY step kind
            assert (signals["native_buy"], signals["native_exit"]) == (scored["buy"], scored["exit"]), (name, step["kind"])
        assert seen["buy"] > scored["buy"]  # the warm-up rows are really in the funnel but not in the segments
    for step in (candidate, holdout):
        bot = step["diagnostics"]["bot"]
        assert bot["native_buy"] == sum(m["native_buy"] for m in step["diagnostics"]["members"])


def test_g6_job_event_exactly_on_the_warmup_row_is_a_decision_and_just_before_it_is_pre_start(
    manifest, rows, synthetic_gate
):
    members = synthetic_members(manifest)
    # Row 1456 carries the first intent at or after row 1251 (member 2 BUY); 426 intents in rows 0..5050.
    first_intent_row = 1456
    on_the_row, just_after = {}, {}
    for warmup, store in ((first_intent_row, on_the_row), (first_intent_row + 1, just_after)):
        request = make_request(manifest, rows, members)
        request["split"] = {**request["split"], "warmup": warmup}
        result = job.evaluate_request(request)
        store.update(result=result, bot=result["diagnostics"]["bot"], per_member=result["diagnostics"]["members"])
    # intents on rows < 1456: 94 (member 1: 50, member 2: 44); the BUY ON row 1456 is a decision, not pre-start
    assert on_the_row["bot"]["pre_start_intents"] == 94
    assert [m["pre_start_intents"] for m in on_the_row["per_member"]] == [50, 44]
    # one row later the same BUY is just before the start row: pre-start, and out of the decisions
    assert just_after["bot"]["pre_start_intents"] == 95
    assert [m["pre_start_intents"] for m in just_after["per_member"]] == [50, 45]
    for held in (on_the_row, just_after):
        bot = held["bot"]
        assert bot["intents_buy"] + bot["intents_exit"] == 426
        assert held["result"]["decision_count"] == 426 - bot["pre_start_intents"]  # pre-start intents never get a decision
    assert (on_the_row["result"]["decision_count"], just_after["result"]["decision_count"]) == (332, 331)


@pytest.mark.parametrize("warmup", [1000, 1003, 1005])
def test_g8_warmup_below_the_1006_floor_is_refused_even_when_5_times_slow_ema_is_lower(
    manifest, rows, synthetic_gate, warmup
):
    other = {**manifest["members"]["M1"]["inputs"], "emaFastInput": 21}  # both members: emaSlow 200, 5 * 200 = 1000
    members = synthetic_members(manifest, ("M1", "M1"), extra=[None, other])
    request = make_request(manifest, rows, members)
    request["split"] = {**request["split"], "warmup": warmup}
    assert code_of(lambda: job.evaluate_request(request)) == "MP_INPUT_INVALID"


def test_g8_warmup_exactly_at_the_1006_floor_is_accepted(manifest, rows, synthetic_gate):
    other = {**manifest["members"]["M1"]["inputs"], "emaFastInput": 21}
    members = synthetic_members(manifest, ("M1", "M1"), extra=[None, other])
    request = make_request(manifest, rows, members)
    request["split"] = {**request["split"], "warmup": 1006}
    result = job.evaluate_request(request)
    assert result["kind"] == "CANDIDATE" and result["train"]["bars"] == manifest["split"]["train_end"] - 1006


def test_n1_bar_input_refusals_leave_as_mp_input_invalid_and_other_codes_are_kept(manifest, rows, synthetic_gate):
    for code in ("INVALID_MARKET_BAR", "INVALID_ATR", "INVALID_OHLC", "INVALID_EXECUTION_MODEL", "UNSUPPORTED_EXECUTION_MODEL"):
        assert job._error_code(ValueError(code)) == "MP_INPUT_INVALID", code
    for kept in ("UNSUPPORTED_SOURCE_HASH", "CUSTOM_EFFECTIVE_INPUT_CHANGED", "MP_CROSS_SOURCE_TARGET", "MP_MEMBER_DUPLICATE_LOGIC"):
        assert job._error_code(ValueError(kept)) == kept
    assert job._error_code(ValueError("NEGATIVE_SPOT_LEDGER")) == "EVALUATION_FAILED"
    assert job._error_code(ValueError("INVALID_ENTRY_LEVELS")) == "EVALUATION_FAILED"
    # end to end: a bar whose high is below its close passes the frame check and is refused by the bar check
    good = make_request(manifest, rows, synthetic_members(manifest))
    for field, value in (("high", "1.00"), ("low", "99999.00"), ("open", "0")):
        bad = copy.deepcopy(good)
        bad["rows"][3000][field] = value
        assert emitted_code(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", field


def test_d8_policy_with_an_extra_key_is_refused(manifest, rows):
    good = make_request(manifest, rows, synthetic_members(manifest))
    assert len(good["policy"]) == 16
    for extra in ({"maxFooBar": 1}, {"killswitch": True}):
        bad = {**good, "policy": {**good["policy"], **extra}}
        assert code_of(lambda b=bad: job.evaluate_request(b)) == "MP_INPUT_INVALID", extra


def test_n10_manifest_records_the_measured_wall_times_with_method_and_machine(manifest):
    timing = manifest["timing"]
    assert timing["method"] and timing["machine_note"]
    runs = {(r["bars"], r["kind"]): r for r in timing["runs"]}
    assert set(runs) == {(6000, "CANDIDATE"), (6000, "HOLDOUT"), (10000, "CANDIDATE"), (10000, "HOLDOUT")}
    for (bars, kind), run in runs.items():
        assert run["rows"] == (bars if kind == "HOLDOUT" else 1250 + (bars - 1250) * 8 // 10)  # rows 0..validation_end
        assert run["repeats"] >= 3 and 0 < run["min_s"] <= run["median_s"] <= run["max_s"]
        assert run["request_kb"] > 0 and run["response_kb"] > 0
