"""Model reachability on synthetic data, not real-data effect.

Each test moves ONE CATALOG dimension (or one Bridge value) from one value to
another, with every other input at a fixed baseline, on a deterministic synthetic
fixture built to exercise that dimension. A pass proves the dimension can change
the evaluator signal vector or the Paper decisions in this model. It says nothing
about whether the dimension changes anything on real BTCUSDT 1m data, and nothing
about profitability.

Three comparison kinds per dimension:
- domain ends: CATALOG minimum vs maximum (CATALOG_CASES).
- interior pair: two ordinary values where BOTH runs fire BUY and EXIT signals, so a
  difference is not just "live vs dead signal" (INTERIOR_CASES).
- one side: for the five gates that act separately on the BUY and the EXIT side
  (zone_atr_mult, setup_expiry, confirm_lookback, sl_atr_buffer, min_risk_atr), a
  fixture where the opposite side stays silent or negligible, comparing only the
  BUY vector on an uptrend or only the EXIT vector on a downtrend (SIDE_CASES).
  confirm_lookback acts on the BUY side through the lookback highs and on the EXIT
  side through the lookback lows; gap bars on an uptrend and mirrored gap bars on a
  downtrend make each clause the deciding one. Every one of these gates is
  exercised on both sides; no side is left unexercised.

Domain notes:
- emaSlowInput has CATALOG minimum 1, but CustomSignalInputs rejects
  ema_fast >= ema_slow, so the lowest reachable value with ema_fast=2 is 3.
  ema_fast=1 makes the fast EMA equal the close, so close > fast never holds and
  no signal can fire; emaFastInput=1 is therefore a dead-signal value.
- Bridge atr_multiplier and rr use the research contract bounds [0.01, 1000]. At
  atr_multiplier=1000 the SL falls below zero, the Bridge model (which mirrors Pine)
  suppresses every entry, so the domain-end comparison is also checked on a
  realistic pair.
- The evaluator keeps BUY and EXIT mutually exclusive through long_bias versus
  exit_bias (opposite SuperTrend direction), so a simultaneous raw BUY and raw EXIT
  cannot occur on any fixture; that tie-break branch is not exercised here.
"""
import math
import random
from dataclasses import dataclass, field, fields, replace
from decimal import Decimal
from functools import lru_cache

import pytest

from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import PaperModel
from robot_quant.spt_custom_evaluator import (
    CATALOG,
    CustomSignalInputs,
    bridge_bars,
    evaluate_bars,
)

BASELINE = CustomSignalInputs(
    ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2, zone_atr_mult=2.5,
    setup_expiry=8, cooldown=2, confirm_lookback=3, sl_atr_buffer=0.60, min_risk_atr=0.50,
)
FIRST_TIME = 1800000000000
BAR_MS = 60000
# trend -> (start price, drift per bar, slow-wave amplitude). Trend 0 is the wavy fixture;
# +1 and -1 drift faster than the wave, so the opposite-side bias almost never holds.
TREND_SHAPES = {0: (100.0, 0.0, 12.0), 1: (100.0, 0.5, 4.0), -1: (900.0, -0.5, 4.0)}


@lru_cache(maxsize=None)
def synthetic_rows(seed, gap_probability=0.0, count=1500, trend=0):
    """Synthetic 1m bars. Only random.Random.random() is used, so it is stable.

    trend 0 is a wave around 100; trend +1 / -1 add a steady drift up / down.
    With gap_probability > 0, a bar that follows a counter-move bar may be replaced
    by a gap bar. Uptrend side (trend >= 0): after a down bar, a red bar that opens
    above the previous high and still closes above it. Downtrend side (trend < 0):
    after an up bar, a green bar that opens below the previous low and still closes
    below it. Such a bar fails confirm clauses 1, 3 and 4, so only the lookback
    high (long) or lookback low (exit) clause can confirm.
    """
    start, drift, amplitude = TREND_SHAPES[trend]
    rnd = random.Random(seed)
    rows, previous_close, previous_high, previous_low = [], start, None, None
    for i in range(count):
        close = start + drift * i + amplitude * math.sin(i / 23) + 2 * math.sin(i / 3) + rnd.random() * 2 - 1
        open_ = previous_close
        if gap_probability and rows:
            previous_open = rows[-1]["open"]
            if trend >= 0 and previous_close < previous_open and rnd.random() < gap_probability:
                open_ = previous_high + 0.4 + rnd.random()
                close = previous_high + 0.1 + (open_ - previous_high - 0.1) * 0.3
            elif trend < 0 and previous_close > previous_open and rnd.random() < gap_probability:
                open_ = previous_low - 0.4 - rnd.random()
                close = previous_low - 0.1 - (previous_low - 0.1 - open_) * 0.3
        high = max(open_, close) + 0.2 + rnd.random()
        low = min(open_, close) - 0.2 - rnd.random()
        rows.append(dict(time=FIRST_TIME + i * BAR_MS, open=open_, high=high, low=low, close=close, volume=1))
        previous_close, previous_high, previous_low = close, high, low
    return rows


SIDES = {"BUY": 0, "EXIT": 1}


def signal_vector(rows, inputs):
    return [(bar.buy, bar.native_exit) for bar in evaluate_bars(rows, inputs)]


def side_vector(rows, inputs, side):
    return [pair[SIDES[side]] for pair in signal_vector(rows, inputs)]


def count_signals(vector):
    return sum(buy for buy, _ in vector), sum(exit_ for _, exit_ in vector)


@dataclass(frozen=True)
class Case:
    name: str
    kind: str
    seed: int
    low: int | float
    high: int | float
    gap_probability: float = 0.0
    trend: int = 0
    side: str | None = None
    baseline_changes: dict = field(default_factory=dict)

    @property
    def id(self):
        return self.name + "-" + self.kind

    def inputs(self, value):
        return replace(BASELINE, **self.baseline_changes, **{CATALOG[self.name][0]: value})

    def rows(self):
        return synthetic_rows(self.seed, self.gap_probability, trend=self.trend)


def build(name, low, high, **options):
    return Case(name, "domain-ends", 1, low, high, **options)


# Domain ends: CATALOG minimum vs maximum, one case per CATALOG name, in CATALOG order.
CATALOG_CASES = [
    # ema_slow=1000 keeps ema_fast below slow at the 500 maximum.
    build("emaFastInput", *CATALOG["emaFastInput"][2:], baseline_changes={"ema_slow": 1000}),
    # Lowest reachable slow value is fast + 1; ema_fast=2 is the smallest live fast EMA.
    build("emaSlowInput", 3, CATALOG["emaSlowInput"][3], baseline_changes={"ema_fast": 2}),
    build("atrLenInput", *CATALOG["atrLenInput"][2:]),
    build("stFactorInput", *CATALOG["stFactorInput"][2:]),
    build("zoneAtrMultInput", *CATALOG["zoneAtrMultInput"][2:]),
    # Narrow zone so a setup is touched earlier than its confirmation bar; cooldown 0 keeps signals dense.
    build("setupExpiryInput", *CATALOG["setupExpiryInput"][2:], baseline_changes={"zone_atr_mult": 0.3, "cooldown": 0}),
    build("cooldownInput", *CATALOG["cooldownInput"][2:]),
    # Gap bars: confirmation can only come from the lookback-high clause.
    build("confirmLookback", *CATALOG["confirmLookback"][2:], gap_probability=0.6),
    # minRisk 3.0 exceeds the baseline buffer, so the buffer decides whether risk passes.
    build("slAtrBufferInput", *CATALOG["slAtrBufferInput"][2:], baseline_changes={"min_risk_atr": 3.0}),
    build("minRiskATRInput", *CATALOG["minRiskATRInput"][2:]),
]

# Interior pairs: both values are live (BUY and EXIT both fire), same fixtures as the domain-end cases.
INTERIOR_PAIRS = {
    "emaFastInput": (2, 500),
    "emaSlowInput": (10, 200),
    "atrLenInput": (3, 40),
    "stFactorInput": (0.5, 2.0),
    "zoneAtrMultInput": (0.5, 5.0),
    "setupExpiryInput": (2, 30),
    "cooldownInput": (0, 10),
    "confirmLookback": (3, 10),
    "slAtrBufferInput": (1.5, 3.0),
    "minRiskATRInput": (0.3, 2.0),
}
INTERIOR_CASES = [
    replace(case, kind="interior", low=INTERIOR_PAIRS[case.name][0], high=INTERIOR_PAIRS[case.name][1])
    for case in CATALOG_CASES
]

# One side: the same five gates at domain ends, BUY vector on an uptrend, EXIT vector on a downtrend.
SIDE_GATES = ("zoneAtrMultInput", "setupExpiryInput", "confirmLookback", "slAtrBufferInput", "minRiskATRInput")
SIDE_CASES = [
    replace(case, kind=side + "-only", side=side, trend=1 if side == "BUY" else -1)
    for side in SIDES
    for case in CATALOG_CASES
    if case.name in SIDE_GATES
]

ALL_CASES = CATALOG_CASES + INTERIOR_CASES + SIDE_CASES


def case_params(cases):
    return pytest.mark.parametrize("case", cases, ids=[case.id for case in cases])


def test_cases_cover_the_ten_catalog_names_once():
    assert [case.name for case in CATALOG_CASES] == list(CATALOG)
    assert [case.name for case in INTERIOR_CASES] == list(CATALOG)
    assert sorted(case.name for case in SIDE_CASES) == sorted(SIDE_GATES * 2)
    assert len({case.id for case in ALL_CASES}) == len(ALL_CASES)


@case_params(ALL_CASES)
def test_model_reachability_both_values_are_valid_inputs(case):
    """Both values construct (no bound or EMA-order error) and sit inside CATALOG."""
    field_name, _, minimum, maximum = CATALOG[case.name]
    assert minimum <= case.low < case.high <= maximum
    low_inputs, high_inputs = case.inputs(case.low), case.inputs(case.high)
    # Only the dimension under test differs between the two input objects.
    differing = {item.name for item in fields(low_inputs) if getattr(low_inputs, item.name) != getattr(high_inputs, item.name)}
    assert differing == {field_name}


@case_params(CATALOG_CASES)
def test_model_reachability_signal_vector_differs_min_vs_max_on_synthetic_data(case):
    rows = case.rows()
    low_vector = signal_vector(rows, case.inputs(case.low))
    high_vector = signal_vector(rows, case.inputs(case.high))
    assert len(low_vector) == len(high_vector) == len(rows)
    assert low_vector != high_vector, case.name + " did not change BUY/EXIT bars on this synthetic fixture"


@case_params(INTERIOR_CASES)
def test_model_reachability_interior_pair_differs_with_both_runs_live(case):
    rows = case.rows()
    low_vector = signal_vector(rows, case.inputs(case.low))
    high_vector = signal_vector(rows, case.inputs(case.high))
    for vector in (low_vector, high_vector):
        buys_count, exits_count = count_signals(vector)
        assert buys_count > 0 and exits_count > 0, case.name + " interior value must fire both sides"
    assert low_vector != high_vector, case.name + " did not change BUY/EXIT bars between two live values"


def test_one_sided_fixtures_keep_the_opposite_side_negligible():
    for trend, gap, own, other in ((1, 0.0, 0, 1), (-1, 0.0, 1, 0), (1, 0.6, 0, 1), (-1, 0.6, 1, 0)):
        counts = count_signals(signal_vector(synthetic_rows(1, gap, trend=trend), BASELINE))
        assert counts[own] > 100 and counts[other] * 20 <= counts[own], (trend, gap, counts)
        if not gap:
            assert counts[other] == 0


@case_params(SIDE_CASES)
def test_model_reachability_one_side_vector_differs_on_a_one_sided_fixture(case):
    """BUY gates are compared on an uptrend and EXIT gates on a downtrend, side vector only."""
    rows = case.rows()
    low_side = side_vector(rows, case.inputs(case.low), case.side)
    high_side = side_vector(rows, case.inputs(case.high), case.side)
    assert len(low_side) == len(high_side) == len(rows)
    assert low_side != high_side, case.name + " did not change the " + case.side + " bars"
    assert sum(low_side) + sum(high_side) > 0


@case_params(ALL_CASES)
def test_model_reachability_each_run_is_deterministic(case):
    rows = case.rows()
    for value in (case.low, case.high):
        first = evaluate_bars(rows, case.inputs(value))
        second = evaluate_bars(rows, case.inputs(value))
        assert first == second
        assert signal_vector(rows, case.inputs(value)) == [(bar.buy, bar.native_exit) for bar in first]

def test_model_reachability_fixture_is_deterministic_and_not_degenerate():
    assert synthetic_rows(1) == synthetic_rows.__wrapped__(1)
    buys_count, exits_count = count_signals(signal_vector(synthetic_rows(1), BASELINE))
    assert buys_count > 20 and exits_count > 20, "baseline must fire on both sides or comparisons prove little"


def test_ema_slow_catalog_minimum_is_unreachable_alone():
    """CATALOG allows emaSlow=1, but fast < slow is enforced, so 1 can never be evaluated."""
    assert CATALOG["emaSlowInput"][2] == 1
    with pytest.raises(ValueError, match="EMA_FAST_MUST_BE_BELOW_SLOW"):
        replace(BASELINE, ema_fast=1, ema_slow=1)


def test_model_reachability_ema_fast_one_is_a_dead_signal_value():
    """fast EMA of length 1 equals the close, so close > fast never holds: no BUY or EXIT."""
    vector = signal_vector(synthetic_rows(1), replace(BASELINE, ema_fast=1))
    assert count_signals(vector) == (0, 0)


def test_confirm_lookback_has_no_effect_without_gap_bars_characterization():
    """Characterization of the model: on gap-free bars clause 4 confirms first, so lookback is inert."""
    for seed in (1, 2, 3):
        rows = synthetic_rows(seed)
        assert signal_vector(rows, replace(BASELINE, confirm_lookback=2)) == signal_vector(
            rows, replace(BASELINE, confirm_lookback=50)
        )


def test_confirm_lookback_gap_effect_holds_across_seeds():
    for seed in (1, 2, 3):
        rows = synthetic_rows(seed, 0.6)
        assert signal_vector(rows, replace(BASELINE, confirm_lookback=2)) != signal_vector(
            rows, replace(BASELINE, confirm_lookback=50)
        )


def test_sl_buffer_and_min_risk_act_through_their_difference_characterization():
    """Risk passes when close - zone > atr * (minRisk - slBuffer); equal differences give equal signals."""
    rows = synthetic_rows(1)
    reference = signal_vector(rows, replace(BASELINE, sl_atr_buffer=0.5, min_risk_atr=1.0))
    assert count_signals(reference) != (0, 0)
    for shift in (0.5, 1.0, 2.0):
        shifted = replace(BASELINE, sl_atr_buffer=0.5 + shift, min_risk_atr=1.0 + shift)
        assert signal_vector(rows, shifted) == reference
    # A different difference does change the output, so slots 9 and 10 are one effective dimension here.
    assert signal_vector(rows, replace(BASELINE, sl_atr_buffer=0.5, min_risk_atr=3.0)) != reference


# ---- Bridge values: Paper replay on the baseline signal vector ----

def paper_policy():
    return dict(killSwitch=False, maxSignalAgeSeconds=120, maxTradesPerDay=10000,
        maxDailyLossR=10000, pauseAfterLossStreak=10000, blockHighVolatility=False,
        maxVolatilityPercent=100, blockDuringNews=False, allowedSymbols=["BTCUSDT"],
        sideMode="BOTH", maxOpenPositions=5, onePositionPerSymbol=False,
        capPercentEquitySize=True, maxRiskPercent=100, maxOrderNotional=10000,
        maxDailyNotional=10000000)


@lru_cache(maxsize=None)
def baseline_bridge_bars():
    rows = synthetic_rows(1)
    return tuple(bridge_bars(rows, evaluate_bars(rows, BASELINE)))


def paper_result(multiplier, rr):
    return paper_replay(
        list(baseline_bridge_bars()), deployment_id="fixture", multiplier=Decimal(str(multiplier)),
        rr=Decimal(str(rr)), model=PaperModel(), policy=paper_policy(), equity=Decimal(1000),
        cash=Decimal(1000), broker="binance-global", symbol="BTCUSDT",
    )


def buys(result, key):
    return [event[key] for event in result["events"] if event["event_type"] == "BUY"]


def exit_reasons(result):
    return {event["reason"] for event in result["events"] if event["event_type"] == "EXIT"}


def test_bridge_baseline_trades_and_is_deterministic():
    first, second = paper_result(1, 1), paper_result(1, 1)
    assert first == second
    assert len(first["fills"]) > 20 and {"SL", "TP"} <= exit_reasons(first)


@pytest.mark.parametrize("low, high", [(0.01, 1000), (0.5, 3)], ids=["domain-ends", "realistic-pair"])
def test_model_reachability_bridge_atr_multiplier_changes_paper_result(low, high):
    low_run, high_run = paper_result(low, 1), paper_result(high, 1)
    assert paper_result(low, 1) == low_run and paper_result(high, 1) == high_run
    assert low_run["decisions"] != high_run["decisions"]
    assert low_run["final_cash"] != high_run["final_cash"]
    if high == 1000:
        # SL below zero is an invalid entry, so the Bridge model suppresses every BUY at the domain maximum.
        assert buys(high_run, "sl") == [] and buys(low_run, "sl") != []
        return
    # Realistic pair: farther SL (distance = ATR * multiplier) and a smaller size for the same risk percent.
    assert buys(low_run, "sl") != buys(high_run, "sl")
    low_quantity = [fill["quantity"] for fill in low_run["fills"] if fill["event_type"] == "BUY"]
    high_quantity = [fill["quantity"] for fill in high_run["fills"] if fill["event_type"] == "BUY"]
    assert Decimal(low_quantity[0]) > Decimal(high_quantity[0])
    assert exit_reasons(low_run) != exit_reasons(high_run)


@pytest.mark.parametrize("low, high", [(0.01, 1000), (1, 3)], ids=["domain-ends", "realistic-pair"])
def test_model_reachability_bridge_rr_changes_paper_result(low, high):
    low_run, high_run = paper_result(1, low), paper_result(1, high)
    assert paper_result(1, low) == low_run and paper_result(1, high) == high_run
    assert low_run["decisions"] != high_run["decisions"]
    assert low_run["final_cash"] != high_run["final_cash"]
    # RR moves only TP: the SL levels of the first entry are equal, the TP levels differ.
    assert buys(low_run, "sl")[0] == buys(high_run, "sl")[0]
    assert buys(low_run, "tp")[0] != buys(high_run, "tp")[0]
    assert Decimal(buys(high_run, "tp")[0]) > Decimal(buys(low_run, "tp")[0])
    assert exit_reasons(low_run) != exit_reasons(high_run) or len(low_run["fills"]) != len(high_run["fills"])
