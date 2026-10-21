"""Combined multi-Pine Paper evaluator ``mp-combined-paper-v1`` (F11, RD-MP-24 to RD-MP-27).

Several Pine members share ONE Bot account. Each member keeps its own Bridge replay (its Pine
entry arrays, capacity, descending EXIT traversal and BUY suppression); the money path is the
unchanged one-Pine ledger ``PaperState``. This module only merges the intents of the member
replays in the same-bar order ``exit-first-ordinal-v1`` and tags nothing: the ledger returned
has exactly the seven keys of ``bridge_paper.paper_replay`` with unchanged record shapes, so a
one-member run is byte-equal to ``paper_replay`` (T-P1) with no member-count branch and no
projection. Everything about members lives in the separate ``diagnostics`` object. The owning
member of a fill or decision is the ``entry_ref`` prefix (``<deployment_id>:<time>:0``).

No one-Pine module is edited or copied. The pair is ONE ``BridgePair`` for all members, and
no member carries a pair (T-P3). Spot, ``paper-close-v1`` and reduce-only EXIT only.

Library errors are ``ValueError`` whose message is a short upper-case code:
``MP_INPUT_INVALID``, ``MP_EVENT_ORDER_UNDEFINED``, ``MP_CROSS_SOURCE_TARGET``. ``policy`` is closed to
exactly the sixteen ``node_policy`` keys (``POLICY_KEYS``): a missing or an extra key is ``MP_INPUT_INVALID``.

Funnel counters (``diagnostics``, ``mp-combined-diagnostics-v1``). Per member (``members[]``, ordinal
order) and for the Bot (``bot``, the same keys, summed from the ledger lists and the replay totals):
``native_buy``, ``native_exit``, ``intents_buy``, ``intents_exit``, ``pre_start_intents``,
``suppressed_buys``, ``skipped_buys``, ``accepted``, ``capped``, ``rejected`` (reason to count) and
``exit_fills`` (exit reason to count). The ``members[]`` entries also carry ``ordinal`` and
``deployment_id``; the top level carries ``version``, ``same_bar_order``, ``cross_source_target`` and
``duplicate_intents``. Counting window: every row handed to the step, warm-up rows included. This
library does not know a split, so a caller that hands rows ``0..validation_end`` (candidate,
sensitivity, stress) or ``0..test_end`` (holdout) gets counts over exactly those rows.
``pre_start_intents`` are the intents with ``time < start_time`` (strict): they stay in ``events``
and never reach the ledger decisions. A BUY the Bridge did not emit is ``suppressed_buys`` when the
member's bar was an exit bar (native exit, or an EXIT intent of that member on the bar) and
``skipped_buys`` otherwise (no ATR yet, or Pine's invalid-level suppression).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal, localcontext

from robot_quant.analytics import PRECISION_CONTEXT, amount
from robot_quant.bridge_replay import BridgeBar, BridgeReplay, PaperModel
from robot_quant.paper_state import PaperState

SAME_BAR_ORDER = "exit-first-ordinal-v1"
DIAGNOSTICS_VERSION = "mp-combined-diagnostics-v1"
LEDGER_KEYS = (
    "events",
    "decisions",
    "fills",
    "final_cash",
    "position_quantity",
    "position_cost",
    "open_allocations",
)
MAX_MEMBERS = 3
POLICY_KEYS = frozenset({
    "killSwitch", "maxSignalAgeSeconds", "maxTradesPerDay", "maxDailyLossR", "pauseAfterLossStreak",
    "blockHighVolatility", "maxVolatilityPercent", "blockDuringNews", "allowedSymbols", "sideMode",
    "maxOpenPositions", "onePositionPerSymbol", "capPercentEquitySize", "maxRiskPercent",
    "maxOrderNotional", "maxDailyNotional",
})

INPUT_INVALID = "MP_INPUT_INVALID"
EVENT_ORDER_UNDEFINED = "MP_EVENT_ORDER_UNDEFINED"
CROSS_SOURCE_TARGET = "MP_CROSS_SOURCE_TARGET"


def _invalid() -> ValueError:
    return ValueError(INPUT_INVALID)


@dataclass(frozen=True)
class BridgePair:
    """The one shared Bridge pair of a combined run. Members never carry a pair."""

    atr_multiplier: Decimal
    rr: Decimal

    def __post_init__(self):
        for value in (self.atr_multiplier, self.rr):
            if type(value) is not Decimal or not value.is_finite() or value <= 0:
                raise _invalid()


@dataclass(frozen=True)
class MemberSignals:
    """One member: dense ``ordinal``, its ``deployment_id`` and one ``(buy, native_exit)`` per bar."""

    ordinal: int
    deployment_id: str
    signals: tuple

    def __post_init__(self):
        if type(self.ordinal) is not int or self.ordinal < 1:
            raise _invalid()
        if type(self.deployment_id) is not str or not self.deployment_id:
            raise _invalid()
        if isinstance(self.signals, (str, bytes)) or not isinstance(self.signals, Sequence):
            raise _invalid()
        rows = tuple(tuple(row) if isinstance(row, (list, tuple)) else row for row in self.signals)
        for row in rows:
            if type(row) is not tuple or len(row) != 2 or type(row[0]) is not bool or type(row[1]) is not bool:
                raise _invalid()
        object.__setattr__(self, "signals", rows)


def member_of_entry_ref(entry_ref: str) -> str:
    """Owning ``deployment_id`` of an ``entry_ref`` (``<deployment_id>:<time>:0``)."""
    return entry_ref.rsplit(":", 2)[0]


def _by_ordinal(members):
    """Ascending ordinal order. The one place the same-bar member order is decided."""
    return sorted(members, key=lambda member: member.ordinal)


class _MergedReplay:
    """Stands in for ``PaperState.replay``: one ``BridgeReplay`` per member, merged per bar.

    ``step(bar, buys, exits)`` takes one boolean per member (ordinal order) instead of one
    boolean for the single replay. Per bar: every member replay steps in ascending ordinal
    (intent generation reads no ledger state), then all EXIT intents by ordinal in each
    member's own traversal order, then all BUY intents by ordinal.
    """

    def __init__(self, members, pair, model, replay_factory=BridgeReplay):
        self.members = tuple(members)
        self.replays = tuple(
            replay_factory(m.deployment_id, pair.atr_multiplier, pair.rr, model) for m in self.members
        )
        self.cross_source_target = 0  # a non-zero value never leaves step(): it raises
        self.duplicate_intents = 0
        self._seen: set = set()
        size = len(self.members)
        self.native_buy = [0] * size
        self.native_exit = [0] * size
        self.suppressed_buys = [0] * size
        self.skipped_buys = [0] * size

    def step(self, bar, buys, exits):
        per_member = []
        for slot, (member, replay) in enumerate(zip(self.members, self.replays, strict=True)):
            buy, native_exit = buys[slot], exits[slot]
            intents = replay.step(bar, buy, native_exit)
            self.native_buy[slot] += buy
            self.native_exit[slot] += native_exit
            exit_bar = native_exit or any(i.event_type == "EXIT" for i in intents)
            if buy and not any(i.event_type == "BUY" for i in intents):
                if exit_bar:
                    self.suppressed_buys[slot] += 1
                else:
                    self.skipped_buys[slot] += 1  # no ATR yet, or Pine's invalid-level suppression
            kept = []
            for intent in intents:
                if member_of_entry_ref(intent.entry_ref) != member.deployment_id:
                    raise ValueError(CROSS_SOURCE_TARGET)
                key = (member.deployment_id, intent.event_type, intent.entry_ref)
                if key in self._seen:
                    self.duplicate_intents += 1
                    continue
                self._seen.add(key)
                kept.append(intent)
            per_member.append(kept)
        merged = [i for kept in per_member for i in kept if i.event_type == "EXIT"]
        merged += [i for kept in per_member for i in kept if i.event_type == "BUY"]
        return merged


class _CombinedPaperState(PaperState):
    """``PaperState`` whose replay is the merged replay. No ledger statement is copied or edited."""

    def __init__(self, *, members, pair, model, policy, equity, cash, broker, symbol,
                 start_time=None, replay_factory=BridgeReplay):
        super().__init__(
            deployment_id=members[0].deployment_id, multiplier=pair.atr_multiplier, rr=pair.rr,
            model=model, policy=policy, equity=equity, cash=cash, broker=broker, symbol=symbol,
            start_time=start_time,
        )
        self.replay = _MergedReplay(members, pair, model, replay_factory)

    def export_state(self):
        raise ValueError("MP_STATE_EXPORT_UNSUPPORTED")

    def import_state(self, state):
        raise ValueError("MP_STATE_EXPORT_UNSUPPORTED")


def _validated_members(members, bars):
    if not isinstance(members, (list, tuple)) or not 1 <= len(members) <= MAX_MEMBERS:
        raise _invalid()
    if any(type(member) is not MemberSignals for member in members):
        raise _invalid()
    if sorted(member.ordinal for member in members) != list(range(1, len(members) + 1)):
        raise _invalid()
    if len({member.deployment_id for member in members}) != len(members):
        raise _invalid()
    if any(len(member.signals) != len(bars) for member in members):
        raise _invalid()
    return _by_ordinal(members)


def _funnel() -> dict:
    return {
        "native_buy": 0, "native_exit": 0, "intents_buy": 0, "intents_exit": 0,
        "pre_start_intents": 0, "suppressed_buys": 0, "skipped_buys": 0,
        "accepted": 0, "capped": 0, "rejected": {}, "exit_fills": {},
    }


def _count_events(funnel, events, start_time):
    for event in events:
        funnel["intents_buy" if event["event_type"] == "BUY" else "intents_exit"] += 1
        if start_time is not None and event["time"] < start_time:
            funnel["pre_start_intents"] += 1


def _count_decisions(funnel, decisions):
    for decision in decisions:
        if decision["outcome"] == "REJECTED":
            funnel["rejected"][decision["reason"]] = funnel["rejected"].get(decision["reason"], 0) + 1
            continue
        if decision["event_type"] == "BUY":
            funnel["capped" if decision["sizing_outcome"] == "CAPPED" else "accepted"] += 1
        else:
            funnel["exit_fills"][decision["reason"]] = funnel["exit_fills"].get(decision["reason"], 0) + 1


def _diagnostics(state, ordered, ledger, start_time) -> dict:
    replay = state.replay
    members = []
    for slot, member in enumerate(ordered):
        mine = member.deployment_id
        funnel = _funnel()
        funnel["native_buy"] = replay.native_buy[slot]
        funnel["native_exit"] = replay.native_exit[slot]
        funnel["suppressed_buys"] = replay.suppressed_buys[slot]
        funnel["skipped_buys"] = replay.skipped_buys[slot]
        _count_events(funnel, [e for e in ledger["events"] if member_of_entry_ref(e["entry_ref"]) == mine],
                      start_time)
        _count_decisions(funnel, [d for d in ledger["decisions"] if member_of_entry_ref(d["entry_ref"]) == mine])
        members.append({"ordinal": member.ordinal, "deployment_id": mine, **funnel})
    # Bot counts come from the ledger lists and the replay totals, not from the member sums.
    bot = _funnel()
    bot["native_buy"] = sum(replay.native_buy)
    bot["native_exit"] = sum(replay.native_exit)
    bot["suppressed_buys"] = sum(replay.suppressed_buys)
    bot["skipped_buys"] = sum(replay.skipped_buys)
    _count_events(bot, ledger["events"], start_time)
    _count_decisions(bot, ledger["decisions"])
    return {
        "version": DIAGNOSTICS_VERSION,
        "same_bar_order": SAME_BAR_ORDER,
        "cross_source_target": replay.cross_source_target,
        "duplicate_intents": replay.duplicate_intents,
        "members": members,
        "bot": bot,
    }


def _run(members, bars, shared_pair, *, model, policy, equity, cash, broker, symbol, start_time,
         same_bar_order, replay_factory) -> dict:
    if same_bar_order != SAME_BAR_ORDER:
        raise ValueError(EVENT_ORDER_UNDEFINED)
    if type(shared_pair) is not BridgePair or type(model) is not PaperModel:
        raise _invalid()
    if not isinstance(bars, (list, tuple)) or any(type(bar) is not BridgeBar for bar in bars):
        raise _invalid()
    if not isinstance(policy, dict) or set(policy) != POLICY_KEYS:
        raise _invalid()
    ordered = _validated_members(members, bars)
    columns = [[row[0] for row in member.signals] for member in ordered]
    exit_columns = [[row[1] for row in member.signals] for member in ordered]
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        state = _CombinedPaperState(
            members=ordered, pair=shared_pair, model=model, policy=policy, equity=equity, cash=cash,
            broker=broker, symbol=symbol, start_time=start_time, replay_factory=replay_factory,
        )
        events, decisions, fills = [], [], []
        for i, bar in enumerate(bars):
            step = state.step(bar, tuple(c[i] for c in columns), tuple(c[i] for c in exit_columns))
            events.extend(step["events"])
            decisions.extend(step["decisions"])
            fills.extend(step["fills"])
        ledger = {
            "events": events,
            "decisions": decisions,
            "fills": fills,
            "final_cash": amount(state.cash),
            "position_quantity": amount(state.quantity),
            "position_cost": amount(state.cost),
            "open_allocations": len(state.positions),
        }
    return {"ledger": ledger, "diagnostics": _diagnostics(state, ordered, ledger, start_time)}


def combined_paper_replay(members, bars, shared_pair, *, model, policy, equity, cash, broker, symbol,
                          start_time=None, same_bar_order) -> dict:
    """Replay 1 to 3 members over shared bars under ONE Bot ledger (RD-MP-24).

    Returns ``{"ledger": <the seven paper_replay keys>, "diagnostics": {...}}``. Accepts members
    in any list order; the ordinals must be exactly ``1..n`` and the order of processing is the
    ascending ordinal. ``same_bar_order`` must be ``exit-first-ordinal-v1``.
    """
    return _run(
        members, bars, shared_pair, model=model, policy=policy, equity=equity, cash=cash,
        broker=broker, symbol=symbol, start_time=start_time, same_bar_order=same_bar_order,
        replay_factory=BridgeReplay,
    )
