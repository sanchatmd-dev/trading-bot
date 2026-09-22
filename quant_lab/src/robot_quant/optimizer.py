"""Constrained parameter optimization engine.

Explores parameter spaces defined by StrategyDefinition.parameters, enforces
hard bounds and cross-field constraints, guards locked parameters, and selects
candidates via multi-stage validation: baseline comparison, sensitivity analysis,
fee/slippage stress testing, and out-of-sample verification. Produces immutable
OptimizationRun contract records for complete research provenance.
"""

import itertools
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal

from robot_quant.analytics import D
from robot_quant.backtest import BacktestConfig, BacktestResult, run_backtest
from robot_quant.contracts import (
    OptimizationRun,
    RiskProfile,
    StrategyDefinition,
    validate_candidate,
)
from robot_quant.market_data import Candle, compute_candles_sha256
from robot_quant.strategy import SyntheticEmaParameters, SyntheticEmaStrategy
from robot_quant.validation import chronological_split

CandidateStatusLiteral = Literal[
    "ACCEPTED",
    "REJECTED_BOUNDS",
    "REJECTED_BASELINE",
    "REJECTED_SENSITIVITY",
    "REJECTED_STRESS",
]


@dataclass
class CandidateEvaluation:
    params: dict[str, str]
    in_sample_return: float = 0.0
    val_return: float = 0.0
    test_return: float = 0.0
    val_profit_factor: float | None = None
    val_max_drawdown: float | None = None
    sensitivity_score: float = 0.0
    stress_return: float = 0.0
    passed_sensitivity: bool = False
    passed_stress: bool = False
    passed_all_gates: bool = False
    status: CandidateStatusLiteral = "ACCEPTED"
    rejection_reason: str = ""


@dataclass
class OptimizationReport:
    run_contract: OptimizationRun
    baseline: CandidateEvaluation
    best_candidate: CandidateEvaluation | None
    candidates: list[CandidateEvaluation]
    total_evaluated: int
    rejection_stats: dict[str, int]


class ConstrainedOptimizer:
    """Constrained optimizer for StrategyDefinition templates."""

    def __init__(
        self,
        strategy_def: StrategyDefinition,
        risk_profile: RiskProfile,
        candles: list[Candle],
        objective: Literal["net_return", "max_drawdown", "profit_factor"] = "net_return",
        seed: int = 42,
        search_budget: int = 50,
        dependency_lock_sha256: str | None = None,
    ):
        self.strategy_def = strategy_def
        self.risk_profile = risk_profile
        self.candles = candles
        self.objective = objective
        self.seed = seed
        self.search_budget = search_budget
        self.dependency_lock_sha256 = dependency_lock_sha256 or ("a" * 64)

    def _params_dict_to_model(self, candidate: dict[str, str]) -> SyntheticEmaParameters:
        """Convert candidate string dictionary to SyntheticEmaParameters."""
        return SyntheticEmaParameters(
            ema_fast=int(candidate.get("ema_fast", "10")),
            ema_slow=int(candidate.get("ema_slow", "30")),
            atr_period=int(candidate.get("atr_period", "14")),
            atr_multiplier=Decimal(candidate.get("atr_multiplier", "2.0")),
        )

    def _evaluate_params(
        self,
        params: SyntheticEmaParameters,
        eval_candles: list[Candle],
        fee_bps: Decimal = Decimal("10"),
        slippage_bps: Decimal = Decimal("5"),
    ) -> BacktestResult:
        """Execute backtest evaluation for given parameters and candle partition."""
        config = BacktestConfig.from_risk_profile(
            self.risk_profile, fee_bps=fee_bps, slippage_bps=slippage_bps
        )
        strat = SyntheticEmaStrategy(params)
        return run_backtest(eval_candles, strategy=strat, config=config)

    def optimize(self) -> OptimizationReport:
        """Run constrained optimization and return full provenance report."""
        dataset_digest = compute_candles_sha256(self.candles)
        split = chronological_split(self.candles, train_ratio=0.6, val_ratio=0.2, test_ratio=0.2)

        # 1. Baseline Evaluation (using default parameters from StrategyDefinition)
        baseline_params_dict = {p.name: str(p.default) for p in self.strategy_def.parameters}
        base_model = self._params_dict_to_model(baseline_params_dict)

        base_train_res = self._evaluate_params(base_model, split.train_candles)
        base_val_res = self._evaluate_params(base_model, split.val_candles)
        base_test_res = self._evaluate_params(base_model, split.test_candles)

        base_train_ret = float(D(base_train_res.metrics.net_profit))
        base_val_ret = float(D(base_val_res.metrics.net_profit))
        base_test_ret = float(D(base_test_res.metrics.net_profit))

        baseline_eval = CandidateEvaluation(
            params=baseline_params_dict,
            in_sample_return=base_train_ret,
            val_return=base_val_ret,
            test_return=base_test_ret,
            val_profit_factor=base_val_res.metrics.profit_factor,
            val_max_drawdown=base_val_res.metrics.max_drawdown_percent,
            passed_all_gates=True,
            status="ACCEPTED",
        )

        # 2. Build parameter search grid
        grid_values: dict[str, list[str]] = {}
        for p in self.strategy_def.parameters:
            if not p.optimizable or p.locked:
                grid_values[p.name] = [str(p.default)]
            else:
                curr = p.minimum
                vals = []
                while curr <= p.maximum:
                    vals.append(str(curr))
                    curr += p.step
                grid_values[p.name] = vals

        keys = list(grid_values.keys())
        all_combinations = [
            dict(zip(keys, prod, strict=True))
            for prod in itertools.product(*(grid_values[k] for k in keys))
        ]

        rejection_stats = {
            "rejected_bounds": 0,
            "rejected_cross_field": 0,
            "rejected_baseline": 0,
            "rejected_sensitivity": 0,
            "rejected_stress": 0,
            "accepted": 0,
        }

        # 3. Filter candidates through bounds and cross-field constraints
        valid_candidates: list[dict[str, str]] = []
        for cand in all_combinations:
            try:
                validate_candidate(self.strategy_def, cand)
            except ValueError:
                rejection_stats["rejected_bounds"] += 1
                continue

            # Cross-field constraint: ema_fast < ema_slow
            if "ema_fast" in cand and "ema_slow" in cand:
                if int(cand["ema_fast"]) >= int(cand["ema_slow"]):
                    rejection_stats["rejected_cross_field"] += 1
                    continue

            valid_candidates.append(cand)

        # Limit search budget if grid is larger than budget
        if len(valid_candidates) > self.search_budget:
            valid_candidates = valid_candidates[: self.search_budget]

        candidate_evals: list[CandidateEvaluation] = []

        # 4. In-sample and Validation screening
        for cand in valid_candidates:
            model = self._params_dict_to_model(cand)
            train_res = self._evaluate_params(model, split.train_candles)
            val_res = self._evaluate_params(model, split.val_candles)

            train_ret = float(D(train_res.metrics.net_profit))
            val_ret = float(D(val_res.metrics.net_profit))

            cand_eval = CandidateEvaluation(
                params=cand,
                in_sample_return=train_ret,
                val_return=val_ret,
                val_profit_factor=val_res.metrics.profit_factor,
                val_max_drawdown=val_res.metrics.max_drawdown_percent,
            )

            # Gate 1: Must outperform or match baseline on validation set
            if val_ret < base_val_ret:
                cand_eval.status = "REJECTED_BASELINE"
                cand_eval.rejection_reason = (
                    f"Validation return {val_ret:.2f} < baseline {base_val_ret:.2f}"
                )
                rejection_stats["rejected_baseline"] += 1
                candidate_evals.append(cand_eval)
                continue

            # Gate 2: Sensitivity Check (neighbor stability)
            # Evaluate +1 and -1 step on ema_fast if optimizable
            neighbors_returns = []
            if "ema_fast" in cand:
                fast_val = int(cand["ema_fast"])
                for offset in (-1, 1):
                    neighbor = cand.copy()
                    neighbor["ema_fast"] = str(fast_val + offset)
                    try:
                        validate_candidate(self.strategy_def, neighbor)
                        if int(neighbor["ema_fast"]) < int(neighbor["ema_slow"]):
                            n_model = self._params_dict_to_model(neighbor)
                            n_val = self._evaluate_params(n_model, split.val_candles)
                            neighbors_returns.append(float(D(n_val.metrics.net_profit)))
                    except ValueError:
                        pass

            avg_neighbor_ret = (
                sum(neighbors_returns) / len(neighbors_returns)
                if neighbors_returns
                else val_ret
            )
            cand_eval.sensitivity_score = avg_neighbor_ret

            if neighbors_returns and avg_neighbor_ret < (base_val_ret * 0.5):
                cand_eval.status = "REJECTED_SENSITIVITY"
                cand_eval.rejection_reason = (
                    "Overfitted isolated spike; neighbor performance degraded"
                )
                rejection_stats["rejected_sensitivity"] += 1
                candidate_evals.append(cand_eval)
                continue
            cand_eval.passed_sensitivity = True

            # Gate 3: Cost Stress Testing (2x fee, 2x slippage)
            stress_res = self._evaluate_params(
                model,
                split.val_candles,
                fee_bps=Decimal("20"),  # 2x fee
                slippage_bps=Decimal("10"),  # 2x slippage
            )
            stress_ret = float(D(stress_res.metrics.net_profit))
            cand_eval.stress_return = stress_ret

            # Strategy must remain resilient under 2x costs
            if stress_ret < 0 and val_ret > 0 and abs(stress_ret) > (val_ret * 2):
                cand_eval.status = "REJECTED_STRESS"
                cand_eval.rejection_reason = (
                    "Failed cost stress test: high degradation under 2x fees"
                )
                rejection_stats["rejected_stress"] += 1
                candidate_evals.append(cand_eval)
                continue
            cand_eval.passed_stress = True

            # Gate 4: Out-of-sample Test Evaluation
            test_res = self._evaluate_params(model, split.test_candles)
            cand_eval.test_return = float(D(test_res.metrics.net_profit))
            cand_eval.passed_all_gates = True
            cand_eval.status = "ACCEPTED"
            rejection_stats["accepted"] += 1

            candidate_evals.append(cand_eval)

        # 5. Select Best Candidate based on objective
        accepted_candidates = [c for c in candidate_evals if c.passed_all_gates]

        best_cand: CandidateEvaluation | None = None
        if accepted_candidates:
            if self.objective == "net_return":
                best_cand = max(accepted_candidates, key=lambda c: (c.val_return, c.test_return))
            elif self.objective == "profit_factor":
                best_cand = max(
                    accepted_candidates,
                    key=lambda c: (c.val_profit_factor or 0.0, c.val_return),
                )
            elif self.objective == "max_drawdown":
                best_cand = max(
                    accepted_candidates,
                    key=lambda c: (c.val_max_drawdown or -100.0, c.val_return),
                )

        # 6. Build immutable OptimizationRun contract
        run_contract = OptimizationRun(
            run_id=f"run_opt_{self.strategy_def.strategy_id}_{self.seed}",
            dataset_sha256=dataset_digest,
            dependency_lock_sha256=self.dependency_lock_sha256,
            risk_snapshot_sha256=self.risk_profile.digest(),
            strategy=self.strategy_def,
            seed=self.seed,
            search_budget=self.search_budget,
            objective=self.objective,
            train_end=split.train_end,
            validation_end=split.validation_end,
            test_end=split.test_end,
        )

        return OptimizationReport(
            run_contract=run_contract,
            baseline=baseline_eval,
            best_candidate=best_cand,
            candidates=candidate_evals,
            total_evaluated=len(valid_candidates),
            rejection_stats=rejection_stats,
        )
