"""Offline contracts and parity engines only; importing this package performs no I/O."""

from robot_quant.analytics import (
    LegacyAdjustment,
    RealizationEvent,
    SummaryMetrics,
    fifo_analytics,
    summarize_closed_positions,
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

__version__ = "0.2.0"

__all__ = [
    "AnalyticsSettingsRecord",
    "Capability",
    "CashJournalRecord",
    "Contract",
    "DailyStats",
    "DatasetManifest",
    "Decision",
    "ExportMetadata",
    "FillRecord",
    "FundingRecord",
    "LegacyAdjustment",
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
    "Scope",
    "SignalRecord",
    "StrategyDefinition",
    "SummaryMetrics",
    "evaluate_risk",
    "fifo_analytics",
    "summarize_closed_positions",
]
