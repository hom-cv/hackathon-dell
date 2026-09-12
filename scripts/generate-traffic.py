#!/usr/bin/env python3
"""Send repeatable concurrent traffic to the inventory read endpoint."""

import argparse
import json
import math
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from time import monotonic, sleep
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from uuid import uuid4


def request_inventory(url: str, timeout: float) -> tuple[bool, float]:
    started = monotonic()
    try:
        request = Request(url, headers={"X-Trace-ID": uuid4().hex})
        with urlopen(request, timeout=timeout) as response:
            response.read()
            return 200 <= response.status < 300, (monotonic() - started) * 1000
    except (HTTPError, URLError, TimeoutError):
        return False, (monotonic() - started) * 1000


def nearest_rank(values: list[float], percentile: float) -> float:
    rank = max(0, math.ceil(percentile * len(values)) - 1)
    return sorted(values)[rank]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default="http://localhost:8000/api/items")
    parser.add_argument("--duration", type=float, default=30)
    parser.add_argument("--rate", type=float, default=5)
    parser.add_argument("--concurrency", type=int, default=10)
    parser.add_argument("--timeout", type=float, default=10)
    args = parser.parse_args()
    if args.duration <= 0 or args.rate <= 0 or args.concurrency <= 0 or args.timeout <= 0:
        parser.error("duration, rate, concurrency, and timeout must all be positive")

    total_requests = max(1, math.ceil(args.duration * args.rate))
    interval = 1 / args.rate
    scheduled_at = monotonic()
    next_progress_at = scheduled_at + 10
    futures = []
    missed_schedules = 0

    print(
        f"Generating {total_requests} requests over {args.duration:g}s against {args.url}...",
        file=sys.stderr,
        flush=True,
    )

    with ThreadPoolExecutor(max_workers=args.concurrency) as executor:
        for index in range(total_requests):
            due_at = scheduled_at + index * interval
            delay = due_at - monotonic()
            if delay > 0:
                sleep(delay)
            elif -delay > interval:
                missed_schedules += 1
            futures.append(executor.submit(request_inventory, args.url, args.timeout))
            now = monotonic()
            if now >= next_progress_at:
                elapsed = min(args.duration, now - scheduled_at)
                print(
                    f"  {elapsed:.0f}s / {args.duration:g}s — {index + 1} requests scheduled",
                    file=sys.stderr,
                    flush=True,
                )
                next_progress_at += 10

    results = [future.result() for future in as_completed(futures)]
    latencies = [latency for _success, latency in results]
    successes = sum(success for success, _latency in results)
    print(json.dumps({
        "url": args.url,
        "scheduled_requests": total_requests,
        "completed_requests": len(results),
        "successful_requests": successes,
        "failed_requests": len(results) - successes,
        "missed_schedules": missed_schedules,
        "mean_latency_ms": round(sum(latencies) / len(latencies), 2),
        "p95_latency_ms": round(nearest_rank(latencies, 0.95), 2),
    }))


if __name__ == "__main__":
    main()
