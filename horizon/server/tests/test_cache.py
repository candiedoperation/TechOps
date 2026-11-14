from concurrent.futures import ThreadPoolExecutor
from threading import Event
from unittest.mock import Mock

import pytest

from app import cache as cache_module
from app.cache import PublicationCache
from app.errors import PublicationNotFound


def test_ttl_lru_and_failed_load(monkeypatch):
    clock = Mock(return_value=0)
    monkeypatch.setattr(cache_module, "monotonic", clock)
    cache = PublicationCache(2, 100)
    load = Mock(return_value="one")
    assert cache.get("one", load, ttl=45) == cache.get("one", load) == "one"
    assert load.call_count == 1
    clock.return_value = 45
    cache.get("one", load, ttl=45)
    assert load.call_count == 2
    cache.get("two", lambda: 2)
    cache.get("three", lambda: 3)
    cache.get("one", load)
    assert load.call_count == 3
    missing = Mock(side_effect=PublicationNotFound)
    for _ in range(2):
        with pytest.raises(PublicationNotFound):
            cache.get("absent", missing)
    assert missing.call_count == 2


def test_single_flight():
    cache = PublicationCache(10, 100)
    entered, release = Event(), Event()

    def slow_read():
        entered.set()
        assert release.wait(2)
        return "read once"

    load = Mock(side_effect=slow_read)
    with ThreadPoolExecutor(max_workers=4) as executor:
        futures = [executor.submit(cache.get, "document", load) for _ in range(4)]
        try:
            assert entered.wait(2)
        finally:
            release.set()
        assert [future.result(timeout=2) for future in futures] == ["read once"] * 4
    load.assert_called_once()


def test_member_reuses_rows_and_keeps_auditing_on_hits(executive, monkeypatch):
    client, _, store, audit = executive
    rows = Mock(wraps=store.rows)
    monkeypatch.setattr(store, "rows", rows)
    route = "/api/v1/rankings/members/fiction-user-1?season=FALL-2026"
    first = client.get(route)
    calls = rows.call_count
    assert calls == 3
    assert client.get(route).json() == first.json()
    assert rows.call_count == calls
    assert [event[1] for event in audit.events] == ["member_detail", "member_detail"]
    assert client.get(route.replace("fiction-user-1", "missing")).status_code == 404
    assert client.get(route.replace("fiction-user-1", "missing")).status_code == 404
