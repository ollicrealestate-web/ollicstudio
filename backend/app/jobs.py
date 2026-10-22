"""Background job execution.

Phase 2 runs jobs in a small thread pool inside the web service. Job state lives in
the database, so a page refresh shows the real status. A job that was cut off by a
server restart is detected when it has not been touched for STALE_AFTER and is then
marked failed with a plain explanation, never left spinning or reported as done.
A separate worker process with retries arrives with the GPU work in Phase 5.
"""

from __future__ import annotations

import logging
import socket
from concurrent.futures import Future, ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

log = logging.getLogger("ollic.jobs")

ACTIVE = ("queued", "running")
FINISHED = ("succeeded", "failed", "cancelled")
STALE_AFTER = timedelta(minutes=10)
WORKER_NAME = f"web:{socket.gethostname()}"[:200]


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _parse(ts: str | None) -> datetime | None:
    if not ts:
        return None
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def is_stale(job: dict, now: datetime | None = None) -> bool:
    if job.get("status") not in ACTIVE:
        return False
    touched = _parse(job.get("updated_at")) or _parse(job.get("created_at"))
    return touched is not None and (now or datetime.now(timezone.utc)) - touched > STALE_AFTER


class ThreadRunner:
    def __init__(self, workers: int = 2):
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="ollic-job")

    def submit(self, fn, *args) -> None:
        fut: Future = self._pool.submit(fn, *args)
        fut.add_done_callback(_log_crash)


class InlineRunner:
    """Runs a job straight away in the calling thread (tests)."""

    def submit(self, fn, *args) -> None:
        fn(*args)


def _log_crash(fut: Future) -> None:
    exc = fut.exception()
    if exc:
        log.error("job crashed outside its own error handling", exc_info=exc)
