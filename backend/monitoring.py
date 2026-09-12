"""Read-only MongoDB queries for the operations dashboard."""

from pymongo import ASCENDING, DESCENDING


LEGACY_MOCK_RUN_ID = "mock-live"


def setup_monitoring(database) -> None:
    """Create useful read indexes and remove the old generated demo feed."""
    database.logs.create_index(
        [("demo_run_id", ASCENDING), ("service", ASCENDING), ("timestamp", DESCENDING)]
    )
    database.logs.create_index("trace_id")
    database.metrics.create_index(
        [("demo_run_id", ASCENDING), ("service", ASCENDING), ("window_end", DESCENDING)]
    )
    database.incidents.create_index(
        [("demo_run_id", ASCENDING), ("state", ASCENDING), ("created_at", DESCENDING)]
    )

    # This run ID was exclusively created by the removed mock replay.
    for name in ("logs", "metrics", "baselines", "deployments", "incidents"):
        database[name].delete_many({"demo_run_id": LEGACY_MOCK_RUN_ID})
    database.runs.delete_many(
        {"$or": [{"_id": LEGACY_MOCK_RUN_ID}, {"demo_run_id": LEGACY_MOCK_RUN_ID}]}
    )


def active_run(database) -> str | None:
    record = database.runs.find_one(
        {"status": "active"},
        sort=[("last_seen_at", DESCENDING), ("started_at", DESCENDING)],
    )
    return record.get("demo_run_id") if record else None


def service_presentations(database) -> list[dict]:
    run_id = active_run(database)
    if not run_id:
        return []

    result = []
    for service in sorted(database.metrics.distinct("service", {"demo_run_id": run_id})):
        latest = database.metrics.find_one(
            {"demo_run_id": run_id, "service": service},
            sort=[("window_end", DESCENDING)],
        )
        baseline = database.baselines.find_one(
            {"demo_run_id": run_id, "service": service},
            sort=[("captured_at", DESCENDING)],
        )
        if not latest or not baseline:
            continue

        history = list(
            database.metrics.find(
                {"demo_run_id": run_id, "service": service},
                {"_id": 0, "window_end": 1, "p95_latency_ms": 1},
            )
            .sort("window_end", DESCENDING)
            .limit(30)
        )
        history.reverse()
        for point in history:
            point["timestamp"] = point.pop("window_end")

        complete = latest.get("telemetry_complete", False)
        degraded = complete and (
            latest["p95_latency_ms"] > baseline["p95_latency_ms"] * 2
            or latest["error_rate"] > 0.01
        )
        result.append(
            {
                "id": service,
                "name": service.replace("_", " ").title(),
                "status": "unknown" if not complete else "degraded" if degraded else "healthy",
                "deployment_id": latest["deployment_id"],
                "observed_at": latest["window_end"],
                "metrics": {
                    "p95_latency_ms": latest["p95_latency_ms"],
                    "error_rate": latest["error_rate"],
                    "request_count": latest["request_count"],
                },
                "baseline_p95_ms": baseline["p95_latency_ms"],
                "history": history,
            }
        )
    return result


def incident_detail(database, incident_id: str) -> dict | None:
    run_id = active_run(database)
    if not run_id:
        return None
    return database.incidents.find_one(
        {"demo_run_id": run_id, "id": incident_id},
        {"_id": 0, "schema_version": 0, "demo_run_id": 0},
    )
