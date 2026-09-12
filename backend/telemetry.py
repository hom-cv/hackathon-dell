"""Small buffered request logger used as a local OpenTelemetry stand-in."""

import logging
from queue import Full, Queue
from threading import Lock, Thread
from typing import Any

from pymongo.collection import Collection
from pymongo.errors import PyMongoError


logger = logging.getLogger(__name__)
_STOP = object()


class TelemetryWriter:
    """Write structured telemetry without adding MongoDB latency to requests."""

    def __init__(self, collection: Collection, queue_size: int = 10_000):
        self._collection = collection
        self._queue: Queue[dict[str, Any] | object] = Queue(maxsize=queue_size)
        self._lock = Lock()
        self._dropped_record_count = 0
        self._write_failure_count = 0
        self._thread = Thread(target=self._run, name="telemetry-writer", daemon=True)

    @property
    def dropped_record_count(self) -> int:
        with self._lock:
            return self._dropped_record_count

    @property
    def write_failure_count(self) -> int:
        with self._lock:
            return self._write_failure_count

    def start(self) -> None:
        self._thread.start()

    def record(self, document: dict[str, Any]) -> None:
        try:
            self._queue.put_nowait(document)
        except Full:
            with self._lock:
                self._dropped_record_count += 1
            logger.error("Telemetry queue is full; request record dropped")

    def flush(self) -> None:
        """Wait until records already in the queue have been attempted."""
        self._queue.join()

    def close(self) -> None:
        self.flush()
        self._queue.put(_STOP)
        self._thread.join()

    def _run(self) -> None:
        while True:
            document = self._queue.get()
            try:
                if document is _STOP:
                    return
                try:
                    self._collection.insert_one(document)
                except PyMongoError as exc:
                    with self._lock:
                        self._write_failure_count += 1
                    logger.error("Telemetry write failed: %s", type(exc).__name__)
            finally:
                self._queue.task_done()
