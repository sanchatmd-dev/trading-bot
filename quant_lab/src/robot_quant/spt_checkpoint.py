"""Restore causal signal state from the dedicated, reviewed SPT state trace.

The caller must independently bind the trace artifact and chart input review to
the source/snapshot. State plots are evidence, not optimization parameters.
"""

import math

from robot_quant.spt_evaluator import SptEvaluator

STATE_FIELDS = {
    "fast": "QL2A State EMA Fast",
    "slow": "QL2A State EMA Slow",
    "atr": "QL2A State ATR",
    "st": "QL2A State Supertrend",
    "direction": "QL2A State Direction",
    "upper": "QL2A State Upper Band",
    "lower": "QL2A State Lower Band",
    "shadow_mismatch": "QL2A Shadow ST Mismatch",
    "long_active": "QL2A State Long Active",
    "exit_active": "QL2A State Exit Active",
    "long_remaining": "QL2A State Long Expiry Remaining",
    "exit_remaining": "QL2A State Exit Expiry Remaining",
    "long_zone": "QL2A State Long Zone",
    "exit_zone": "QL2A State Exit Zone",
    "cooldown_elapsed": "QL2A State Cooldown Elapsed",
}


def restore_checkpoint(rows: list[dict], index: int = 5) -> SptEvaluator:
    if not 4 <= index < len(rows):
        raise ValueError("CHECKPOINT_REQUIRES_PREVIOUS_FIVE_BARS")
    state = rows[index]["source_state"]
    for name, value in state.items():
        if value is not None and not math.isfinite(value):
            raise ValueError("NONFINITE_CHECKPOINT:" + name)
    if any(
        state[k] is None or state[k] <= 0 for k in ["fast", "slow", "atr", "st", "upper", "lower"]
    ):
        raise ValueError("UNINITIALIZED_CHECKPOINT")
    if (
        state["direction"] not in [-1, 1]
        or any(state[k] not in [0, 1] for k in ["long_active", "exit_active"])
        or state["shadow_mismatch"] != 0
        or state["st"] != state["lower" if state["direction"] == -1 else "upper"]
    ):
        raise ValueError("INCONSISTENT_SUPERTREND_CHECKPOINT")
    for active, remaining, zone in [
        ("long_active", "long_remaining", "long_zone"),
        ("exit_active", "exit_remaining", "exit_zone"),
    ]:
        if state[remaining] is not None and state[remaining] != int(state[remaining]):
            raise ValueError("INVALID_SETUP_EXPIRY")
        if state[active] and (state[remaining] is None or state[zone] is None):
            raise ValueError("MISSING_ACTIVE_SETUP_STATE")
    elapsed = state["cooldown_elapsed"]
    if elapsed is not None and (elapsed < 0 or elapsed != int(elapsed)):
        raise ValueError("INVALID_COOLDOWN_STATE")
    result = SptEvaluator()
    result.index = index
    for name in ["fast", "slow", "atr", "st", "upper", "lower"]:
        setattr(result, name, state[name])
    result.direction = int(state["direction"])
    result.long_active, result.exit_active = bool(state["long_active"]), bool(state["exit_active"])
    result.long_expiry = (
        index + int(state["long_remaining"]) if state["long_remaining"] is not None else -1
    )
    result.exit_expiry = (
        index + int(state["exit_remaining"]) if state["exit_remaining"] is not None else -1
    )
    result.long_zone, result.exit_zone = state["long_zone"], state["exit_zone"]
    result.trade_start = index - int(elapsed) if elapsed is not None else None
    row = rows[index]
    result.previous = *(float(row[k]) for k in ["open", "high", "low", "close"]), result.fast
    result.highs = [float(r["high"]) for r in rows[index - 4 : index + 1]]
    result.lows = [float(r["low"]) for r in rows[index - 4 : index + 1]]
    return result
