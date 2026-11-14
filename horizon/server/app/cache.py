"""Bounded process-local publication cache. Failed loads are shared, then forgotten."""

from collections import OrderedDict
from collections.abc import Callable, Hashable
from concurrent.futures import Future
from threading import Lock
from time import monotonic
from typing import Any, TypeVar, cast

from fastapi import Request

T = TypeVar("T")


class PublicationCache:
    def __init__(self, size: int, ttl: float):
        self.size = size
        self.ttl = ttl
        self.entries: OrderedDict[Hashable, tuple[float, Any]] = OrderedDict()
        self.loading: dict[Hashable, Future[Any]] = {}
        self.lock = Lock()

    def get(
        self, key: Hashable, load: Callable[[], T], *, ttl: float | None = None
    ) -> T:
        with self.lock:
            entry = self.entries.pop(key, None)
            if entry is not None and entry[0] > monotonic():
                self.entries[key] = entry
                return cast(T, entry[1])
            future = self.loading.get(key)
            if future is None:
                future = self.loading[key] = Future()
                leader = True
            else:
                leader = False
        if not leader:
            return cast(T, future.result())
        try:
            value = load()
            with self.lock:
                self.entries[key] = (
                    monotonic() + (self.ttl if ttl is None else ttl),
                    value,
                )
                if len(self.entries) > self.size:
                    self.entries.popitem(last=False)
            future.set_result(value)
            return value
        except BaseException as error:
            future.set_exception(error)
            raise
        finally:
            with self.lock:
                del self.loading[key]


def get_cache(request: Request) -> PublicationCache:
    return request.app.state.publication_cache
