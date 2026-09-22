"""Offline contracts and parity engines only; importing this package performs no I/O."""

from robot_quant.analytics import (
    LegacyAdjustment,
    RealizationEvent,
    SummaryMetrics,
    fifo_analytics,
    summarize_closed_positions,
)
from robot_quant.backtest import (
    BacktestConfig,
    BacktestEngine,
    BacktestResult,
    run_backtest,
)
from robot_quant.contracts import (
    Capability,
    Contract,
    Decision,
    ExportMetadata,
    OptimizationRun,
    ParameterBounds,
    PositionIntent,
    RiskProfile,
    Scope,
    StrategyDefinition,
)
from robot_quant.market_data import (
    Candle,
    candles_to_dataframe,
    compute_candles_sha256,
    generate_synthetic_ohlcv,
    load_candles_from_parquet,
    query_candles_with_duckdb,
    save_candles_to_parquet,
)
from robot_quant.optimizer import (
    CandidateEvaluation,
    ConstrainedOptimizer,
    OptimizationReport,
)
from robot_quant.records import (
    AnalyticsSettingsRecord,
    CashJournalRecord,
    DatasetManifest,
    FillRecord,
    FundingRecord,
    PositionAllocationRecord,
    SignalRecord,
)
from robot_quant.risk_evaluator import (
    DailyStats,
    PositionState,
    RiskContext,
    RiskEvaluationResult,
    RiskPolicy,
    evaluate_risk,
)
from robot_quant.risk_preview import (
    RiskSimulationPreview,
    generate_risk_preview,
)
from robot_quant.strategy import (
    StrategySignal,
    SyntheticEmaParameters,
    SyntheticEmaStrategy,
)
from robot_quant.validation import (
    ChronologicalDatasetSplit,
    WalkForwardWindow,
    chronological_split,
    walk_forward_windows,
)

__version__ = "0.3.0"

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
