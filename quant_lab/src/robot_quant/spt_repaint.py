"""Compare snapshot-bound captured native flags with later chart history."""

from decimal import Decimal


def repaint_comparison(rows: list[dict], capture: dict, bundle: dict, checkpoint: dict) -> dict:
    deployment = bundle["deployment"]
    if (
        capture.get("deployment_id") != deployment["deployment_id"]
        or capture.get("snapshot_hash") != deployment["snapshot_hash"]
        or capture.get("source_hash") != deployment["snapshot"]["source_hash"]
        or capture.get("trace_artifact_hash") != checkpoint["trace_artifact_hash"]
        or capture.get("chart_review_sha256") != checkpoint["chart_review_sha256"]
    ):
        raise ValueError("NATIVE_CAPTURE_PROVENANCE_MISMATCH")
    historical = {r["time"]: r for r in rows}
    seen = set()
    compared = changed = pending = 0
    for record in capture["events"]:
        payload = record["payload"]
        time = payload["bar_time"]
        if (
            payload.get("schema_version") != "bridge-native-trace-v1"
            or any(
                payload.get(k) != deployment["snapshot"]["market"][k]
                for k in [
                    "deployment_id",
                    "pine_import_id",
                    "source_version",
                    "broker",
                    "symbol",
                    "timeframe",
                ]
            )
            or payload.get("event_id") != f"{deployment['deployment_id']}:{time}:NATIVE_TRACE"
            or time in seen
            or not time <= record["received_at"] <= time + 300000
            or record["received_at"] > capture["exported_at"]
            or type(payload.get("native_buy")) is not bool
            or type(payload.get("native_exit")) is not bool
        ):
            raise ValueError("INVALID_RECORDED_NATIVE_OBSERVATION")
        seen.add(time)
        row = historical.get(time)
        if row is None or record["received_at"] > row["historical_exported_at"]:
            pending += 1
            continue
        compared += 1
        if (
            row["buy"] != payload["native_buy"]
            or row["native_exit"] != payload["native_exit"]
            or Decimal(row["close"]) != Decimal(str(payload["close"]))
        ):
            changed += 1
    return {
        "recorded_closed_observations": len(seen),
        "compared_to_later_history": compared,
        "not_in_historical_export": pending,
        "changed": changed,
        "required": 100,
        "matched": compared >= 100 and changed == 0,
        "capture_id": capture["capture_id"],
        "capture_exported_at": capture["exported_at"],
    }
