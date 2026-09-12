"""Deterministic request-window regression detection."""

import logging
import math
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from threading import Event, Thread
from uuid import uuid4

from pymongo.errors import DuplicateKeyError, PyMongoError


logger = logging.getLogger(__name__)


def nearest_rank(values: list[float], percentile: float) -> float:
    rank = max(0, math.ceil(percentile * len(values)) - 1)
    return sorted(values)[rank]


class IncidentDetector:
    def __init__(
        self,
        database,
        run_id: str,
        interval_seconds: float = 2,
        window_seconds: int = 10,
        minimum_requests: int = 30,
        baseline_windows: int = 6,
    ):
        self.database = database
        self.run_id = run_id
        self.interval_seconds = interval_seconds
        self.window_seconds = window_seconds
        self.minimum_requests = minimum_requests
        self.baseline_windows = baseline_windows
        self._stop = Event()
        self._thread = Thread(target=self._run, name="incident-detector", daemon=True)

    def start(self) -> None:
        self._thread.start()

    def close(self) -> None:
        self._stop.set()
        self._thread.join(timeout=self.interval_seconds + 5)

    def evaluate(self, now: datetime | None = None) -> dict | None:
        now = now or datetime.now(timezone.utc)
        windows = self._request_windows(now)
        if not windows:
            return None

        baseline = self.database.baselines.find_one({
            "demo_run_id": self.run_id,
            "service": "inventory",
            "route": "/api/items",
        })
        if baseline is None:
            baseline = self._capture_baseline(windows, now)
            if baseline is None:
                return None

        candidates = [window for window in windows if window["window_start"] >= baseline["window_end"]]
        if len(candidates) < 2:
            return None
        previous, latest = candidates[-2:]
        if (
            previous["request_count"] < self.minimum_requests
            or latest["request_count"] < self.minimum_requests
            or latest["window_start"] - previous["window_start"] != timedelta(seconds=self.window_seconds)
            or previous["deployment_id"] != latest["deployment_id"]
        ):
            return None

        latency_threshold = max(3 * baseline["p95_latency_ms"], 100)
        query_threshold = max(3 * baseline["mean_db_queries"], baseline["mean_db_queries"] + 2)

        def regressions(window: dict) -> set[str]:
            result = set()
            if window["p95_latency_ms"] > latency_threshold:
                result.add("latency")
            if window["mean_db_queries"] > query_threshold:
                result.add("database_queries")
            return result

        triggered = regressions(previous) & regressions(latest)
        if not triggered:
            return None

        rule = "database_query_regression" if "database_queries" in triggered else "latency_regression"
        incident_id = f"incident-{uuid4().hex[:12]}"
        dedup_key = f"{self.run_id}:inventory:{latest['deployment_id']}:{rule}"
        def evidence_window(window: dict) -> dict:
            return {
                key: value for key, value in window.items()
                if key not in {"durations", "query_counts"}
            }

        incident = {
            "_id": incident_id,
            "id": incident_id,
            "schema_version": 1,
            "demo_run_id": self.run_id,
            "service": "inventory",
            "route": "/api/items",
            "deployment_id": latest["deployment_id"],
            "git_sha": latest["git_sha"],
            "state": "open",
            "severity": "critical",
            "rule": rule,
            "summary": (
                "Inventory database query count regressed after deployment."
                if rule == "database_query_regression"
                else "Inventory request latency regressed after deployment."
            ),
            "created_at": now,
            "updated_at": now,
            "dedup_key": dedup_key,
            "baseline": {
                "id": baseline["_id"],
                "deployment_id": baseline["deployment_id"],
                "git_sha": baseline["git_sha"],
                "p95_latency_ms": baseline["p95_latency_ms"],
                "mean_db_queries": baseline["mean_db_queries"],
            },
            "thresholds": {
                "p95_latency_ms": latency_threshold,
                "mean_db_queries": query_threshold,
                "consecutive_windows": 2,
                "minimum_requests": self.minimum_requests,
            },
            "observed_windows": [evidence_window(previous), evidence_window(latest)],
            "evidence_trace_ids": (previous["trace_ids"] + latest["trace_ids"])[:20],
        }
        try:
            self.database.incidents.insert_one(incident)
        except DuplicateKeyError:
            return self.database.incidents.find_one({"dedup_key": dedup_key})
        logger.warning("Created incident %s for %s", incident_id, rule)
        return incident

    def _capture_baseline(self, windows: list[dict], now: datetime) -> dict | None:
        complete = [window for window in windows if window["request_count"] >= self.minimum_requests]
        for start in range(len(complete) - self.baseline_windows + 1):
            group = complete[start:start + self.baseline_windows]
            if len({window["deployment_id"] for window in group}) != 1:
                continue
            if any(
                right["window_start"] - left["window_start"] != timedelta(seconds=self.window_seconds)
                for left, right in zip(group, group[1:])
            ):
                continue
            durations = [duration for window in group for duration in window["durations"]]
            query_counts = [count for window in group for count in window["query_counts"]]
            baseline_id = f"baseline-{uuid4().hex[:12]}"
            baseline = {
                "_id": baseline_id,
                "schema_version": 1,
                "demo_run_id": self.run_id,
                "service": "inventory",
                "route": "/api/items",
                "deployment_id": group[0]["deployment_id"],
                "git_sha": group[0]["git_sha"],
                "captured_at": now,
                "window_start": group[0]["window_start"],
                "window_end": group[-1]["window_end"],
                "sample_count": len(durations),
                "p95_latency_ms": nearest_rank(durations, 0.95),
                "mean_db_queries": sum(query_counts) / len(query_counts),
            }
            try:
                self.database.baselines.insert_one(baseline)
            except DuplicateKeyError:
                return self.database.baselines.find_one({
                    "demo_run_id": self.run_id,
                    "service": "inventory",
                    "route": "/api/items",
                })
            logger.info("Captured healthy baseline %s", baseline_id)
            return baseline
        return None

    def _request_windows(self, now: datetime) -> list[dict]:
        lookback = now - timedelta(hours=1)
        records = self.database.logs.find({
            "demo_run_id": self.run_id,
            "service": "inventory",
            "event": "request.completed",
            "http_method": "GET",
            "http_route": "/api/items",
            "timestamp": {"$gte": lookback, "$lt": now},
        }, {
            "_id": 0,
            "timestamp": 1,
            "duration_ms": 1,
            "db_query_count": 1,
            "deployment_id": 1,
            "git_sha": 1,
            "trace_id": 1,
            "status_code": 1,
        })
        grouped = defaultdict(list)
        for record in records:
            epoch = int(record["timestamp"].timestamp())
            window_epoch = epoch - epoch % self.window_seconds
            window_start = datetime.fromtimestamp(window_epoch, timezone.utc)
            grouped[(window_start, record.get("deployment_id", "unknown"))].append(record)

        windows = []
        for (window_start, deployment_id), samples in grouped.items():
            window_end = window_start + timedelta(seconds=self.window_seconds)
            if window_end > now:
                continue
            durations = [float(sample["duration_ms"]) for sample in samples]
            query_counts = [int(sample.get("db_query_count", 0)) for sample in samples]
            windows.append({
                "window_start": window_start,
                "window_end": window_end,
                "deployment_id": deployment_id,
                "git_sha": samples[-1].get("git_sha", "unknown"),
                "request_count": len(samples),
                "error_count": sum(sample.get("status_code", 500) >= 500 for sample in samples),
                "p95_latency_ms": nearest_rank(durations, 0.95),
                "mean_db_queries": sum(query_counts) / len(query_counts),
                "durations": durations,
                "query_counts": query_counts,
                "trace_ids": [sample["trace_id"] for sample in samples[-10:]],
            })
        return sorted(windows, key=lambda window: window["window_start"])

    def _run(self) -> None:
        while not self._stop.wait(self.interval_seconds):
            try:
                self.evaluate()
            except PyMongoError as exc:
                logger.error("Incident detection failed: %s", type(exc).__name__)
            except Exception:
                logger.exception("Unexpected incident detection failure")
