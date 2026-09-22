"""Storage and dataset manifest verification using DuckDB and PyArrow.

Ensures datasets are immutable, cryptographically verifiable, and maintain exact
string representations of monetary fields without float coercion.
"""

import hashlib
import json
from typing import Any

from robot_quant.records import (
    CashJournalRecord,
    DatasetManifest,
    FillRecord,
    FundingRecord,
    PositionAllocationRecord,
    SignalRecord,
)


def compute_records_sha256(records: list[dict[str, Any]]) -> str:
    """Compute a deterministic SHA-256 hash of a sequence of dictionary records."""
    hasher = hashlib.sha256()
    for item in sorted(records, key=lambda x: json.dumps(x, sort_keys=True)):
        hasher.update(json.dumps(item, sort_keys=True).encode("utf-8"))
    return hasher.hexdigest()


def create_manifest(
    dataset_id: str,
    scope: Any,
    signals: list[SignalRecord],
    fills: list[FillRecord],
    cash_journal: list[CashJournalRecord],
    funding: list[FundingRecord],
    allocations: list[PositionAllocationRecord] | None = None,
    source: str = "SYNTHETIC_FIXTURE",
    cutoff_at: int = 0,
    created_at: int = 0,
) -> DatasetManifest:
    """Create a verified DatasetManifest for a collection of records."""
    all_dicts: list[dict[str, Any]] = []
    all_dicts.extend([s.model_dump(mode="json") for s in signals])
    all_dicts.extend([f.model_dump(mode="json") for f in fills])
    all_dicts.extend([c.model_dump(mode="json") for c in cash_journal])
    all_dicts.extend([fn.model_dump(mode="json") for fn in funding])
    if allocations:
        all_dicts.extend([a.model_dump(mode="json") for a in allocations])

    digest = compute_records_sha256(all_dicts)

    return DatasetManifest(
        dataset_id=dataset_id,
        schema_version=12,
        source=source,  # type: ignore[arg-type]
        scope=scope,
        created_at=created_at,
        cutoff_at=cutoff_at,
        signals_count=len(signals),
        fills_count=len(fills),
        cash_journal_count=len(cash_journal),
        funding_count=len(funding),
        allocations_count=len(allocations) if allocations else 0,
        sha256=digest,
    )


def verify_manifest(
    manifest: DatasetManifest,
    signals: list[SignalRecord],
    fills: list[FillRecord],
    cash_journal: list[CashJournalRecord],
    funding: list[FundingRecord],
    allocations: list[PositionAllocationRecord] | None = None,
) -> bool:
    """Verify that records match the manifest's counts and SHA-256 hash."""
    if len(signals) != manifest.signals_count:
        return False
    if len(fills) != manifest.fills_count:
        return False
    if len(cash_journal) != manifest.cash_journal_count:
        return False
    if len(funding) != manifest.funding_count:
        return False
    if allocations and len(allocations) != manifest.allocations_count:
        return False

    all_dicts: list[dict[str, Any]] = []
    all_dicts.extend([s.model_dump(mode="json") for s in signals])
    all_dicts.extend([f.model_dump(mode="json") for f in fills])
    all_dicts.extend([c.model_dump(mode="json") for c in cash_journal])
    all_dicts.extend([fn.model_dump(mode="json") for fn in funding])
    if allocations:
        all_dicts.extend([a.model_dump(mode="json") for a in allocations])

    actual_digest = compute_records_sha256(all_dicts)
    return actual_digest == manifest.sha256
