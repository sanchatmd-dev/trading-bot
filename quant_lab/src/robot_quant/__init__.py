"""Offline contracts and parity engines with lazily loaded public exports.

Python runs this package initializer before any ``python -m robot_quant.*``
entry point. Keep data libraries out of the evaluator's I/O readiness path.
"""

from importlib import import_module

__version__ = "0.3.0"

_EXPORT_GROUPS = {
    "analytics": (
        "LegacyAdjustment",
        "RealizationEvent",
        "SummaryMetrics",
        "fifo_analytics",
        "summarize_closed_positions",
    ),
    "backtest": (
        "BacktestConfig",
        "BacktestEngine",
        "BacktestResult",
        "run_backtest",
    ),
    "contracts": (
        "Capability",
        "Contract",
        "Decision",
        "ExportMetadata",
        "OptimizationRun",
        "ParameterBounds",
        "PositionIntent",
        "RiskProfile",
        "Scope",
        "StrategyDefinition",
    ),
    "market_data": (
        "Candle",
        "candles_to_dataframe",
        "compute_candles_sha256",
        "generate_synthetic_ohlcv",
        "load_candles_from_parquet",
        "query_candles_with_duckdb",
        "save_candles_to_parquet",
    ),
    "optimizer": (
        "CandidateEvaluation",
        "ConstrainedOptimizer",
        "OptimizationReport",
    ),
    "records": (
        "AnalyticsSettingsRecord",
        "CashJournalRecord",
        "DatasetManifest",
        "FillRecord",
        "FundingRecord",
        "PositionAllocationRecord",
        "SignalRecord",
    ),
    "risk_evaluator": (
        "DailyStats",
        "PositionState",
        "RiskContext",
        "RiskEvaluationResult",
        "RiskPolicy",
        "evaluate_risk",
    ),
    "risk_preview": (
        "RiskSimulationPreview",
        "generate_risk_preview",
    ),
    "strategy": (
        "StrategySignal",
        "SyntheticEmaParameters",
        "SyntheticEmaStrategy",
    ),
    "validation": (
        "ChronologicalDatasetSplit",
        "WalkForwardWindow",
        "chronological_split",
        "walk_forward_windows",
    ),
}
_EXPORT_MODULES = {name: module for module, names in _EXPORT_GROUPS.items() for name in names}

__all__ = [
    "AnalyticsSettingsRecord",
    "BacktestConfig",
    "BacktestEngine",
    "BacktestResult",
    "Candle",
    "CandidateEvaluation",
    "Capability",
    "CashJournalRecord",
    "ChronologicalDatasetSplit",
    "ConstrainedOptimizer",
    "Contract",
    "DailyStats",
    "DatasetManifest",
    "Decision",
    "ExportMetadata",
    "FillRecord",
    "FundingRecord",
    "LegacyAdjustment",
    "OptimizationReport",
    "OptimizationRun",
    "ParameterBounds",
    "PositionAllocationRecord",
    "PositionIntent",
    "PositionState",
    "RealizationEvent",
    "RiskContext",
    "RiskEvaluationResult",
    "RiskPolicy",
    "RiskProfile",
    "RiskSimulationPreview",
    "Scope",
    "SignalRecord",
    "StrategyDefinition",
    "StrategySignal",
    "SummaryMetrics",
    "SyntheticEmaParameters",
    "SyntheticEmaStrategy",
    "WalkForwardWindow",
    "candles_to_dataframe",
    "chronological_split",
    "compute_candles_sha256",
    "evaluate_risk",
    "fifo_analytics",
    "generate_risk_preview",
    "generate_synthetic_ohlcv",
    "load_candles_from_parquet",
    "query_candles_with_duckdb",
    "run_backtest",
    "save_candles_to_parquet",
    "summarize_closed_positions",
    "walk_forward_windows",
]


def __getattr__(name):
    module = _EXPORT_MODULES.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    value = getattr(import_module(f".{module}", __name__), name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(__all__))
