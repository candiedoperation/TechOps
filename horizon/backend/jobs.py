"""Pull-only scheduled jobs and immutable weekly snapshot orchestration.

The job layer consumes the aggregate records produced by
``backend.ingestion`` and the pure functions in ``backend.rules``.  It does
not import notification clients or expose source payloads.  Every write is an
append, and a snapshot is only created after its warning evidence has been
validated.
"""

from __future__ import annotations

import asyncio
import inspect
import logging
from collections import defaultdict
from collections.abc import Callable, Mapping, Sequence
from datetime import date, datetime, timedelta, timezone
from math import ceil
from typing import Any
from weakref import WeakValueDictionary

import anyio

from .code_evidence import GiteaCodeEvidenceReader, HistoryMetadata
from .config import Settings, get_settings
from .cumulative_llm import (
    CUMULATIVE_VERSION,
    CumulativeCheckpoint,
    CumulativeCheckpointJudge,
    checkpoint_is_fresh,
    judge_project_cumulative,
)
from .db import get_active_repository
from .llm import LLMUnavailable
from .ingestion import (
    AuthentikTeamHierarchyAdapter,
    GiteaRepoActivityAdapter,
    PeoplePortalDirectoryAdapter,
    SyncResult,
)
from .models import (
    AggregateMetrics,
    AttentionStatus,
    CumulativeCheckpointDocument,
    EvidenceReference,
    RepoActivityDocument,
    WarningDocument,
    WarningEvidenceItem,
    WarningSeverity,
    WeeklySnapshotDocument,
    new_id,
)
from .people_portal import PeoplePortalSdkClient
from .resolvers import build_boundary_resolver, build_team_size_resolver
from .rules import evaluate_mvp_rules
from .signal_llm import SIGNAL_VERSION, WeeklySignal, WeeklySignalJudge, judge_project_week
from .staging import (
    REPO_ACTIVITY_STAGING_COLLECTION,
    fold_people_portal_catalog,
    fold_staging_activity,
    open_staging_store,
)


WEEKLY_SNAPSHOTS_COLLECTION = "weekly_snapshots"


def _document(model: type[Any], **values: Any) -> Any:
    """Construct a Beanie document without requiring a live collection.

    The local/demo repository deliberately runs without Mongo initialization.
    ``model_construct`` keeps that path usable while production persistence
    still receives the same validated field values through the repository.
    """

    return model.model_construct(**values)


def _utc_now() -> datetime:
    return datetime.now(timezone.utc)


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, date):
        return datetime.combine(value, datetime.min.time(), tzinfo=timezone.utc)
    if isinstance(value, str):
        candidate = value.strip()
        if candidate.endswith("Z"):
            candidate = candidate[:-1] + "+00:00"
        try:
            parsed = datetime.fromisoformat(candidate)
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    return None


def _iso(value: Any) -> str | None:
    parsed = _parse_datetime(value)
    return parsed.astimezone(timezone.utc).isoformat().replace("+00:00", "Z") if parsed else None


def _field(row: Any, name: str, default: Any = None) -> Any:
    if isinstance(row, Mapping):
        return row.get(name, default)
    return getattr(row, name, default)


def _record_id(row: Any) -> str | None:
    for name in ("id", "_id", "source_ref", "snapshot_id"):
        value = _field(row, name)
        if value not in (None, ""):
            return str(value)
    return None


def _metric_map(row: Any) -> dict[str, Any]:
    if hasattr(row, "aggregate_metrics"):
        try:
            metrics = row.aggregate_metrics()
            return metrics.model_dump(exclude_none=True)
        except (AttributeError, TypeError, ValueError):
            pass
    raw = _field(row, "metrics", {})
    result = dict(raw) if isinstance(raw, Mapping) else {}
    metric_names = (
        "active_days",
        "days_since_activity",
        "open_prs",
        "oldest_open_pr_days",
        "review_latency_days",
        "merged_count",
        "active_contributors",
        "team_size",
        "aggregation_floor",
        "data_completeness_pct",
        "last_sync_at",
    )
    for name in metric_names:
        value = _field(row, name)
        if value is not None:
            result[name] = value
    source_ref = _record_id(row)
    if source_ref:
        result["source_ref"] = source_ref
    return result


def _project_ids(row: Any) -> list[str]:
    value = _field(row, "project_ids")
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        return [str(item) for item in value if item not in (None, "")]
    project_id = _field(row, "project_id")
    return [str(project_id)] if project_id not in (None, "") else []


def _record_week(record: Mapping[str, Any]) -> date | None:
    """Return the ISO week-start date a folded history record belongs to."""

    value = record.get("week_start")
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _activity_completeness_rank(row: Any) -> tuple[int, str]:
    """Order repo_activity rows for one (project, repo, week) key, best last.

    A row carrying pull-request aggregates came from the Gitea sync; a row
    without them was written by a commit-only path and must never shadow the
    synced one.  Ties break on ``synced_at`` so the freshest sync wins.
    """

    has_pr_data = any(
        _field(row, name) is not None
        for name in ("open_prs", "merged_count", "oldest_open_pr_days", "review_latency_days")
    )
    synced_at = _field(row, "synced_at")
    return (1 if has_pr_data else 0, str(synced_at or ""))


def _best_activity_by_repo(rows: Sequence[Any]) -> dict[str, Any]:
    """Collapse repo_activity rows to the most complete one per repo slug."""

    best: dict[str, Any] = {}
    for row in sorted(rows, key=_activity_completeness_rank):
        slug = _field(row, "repo_slug")
        if slug:
            best[str(slug)] = row
    return best


def _history_by_project(rows: Sequence[Any]) -> dict[str, list[dict[str, Any]]]:
    buckets: dict[tuple[str, str], list[Any]] = defaultdict(list)
    for row in rows:
        week = _field(row, "window_start", _field(row, "week_start", _field(row, "snapshot_week_start")))
        for project_id in _project_ids(row):
            buckets[(project_id, str(week or "unknown"))].append(row)

    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for (project_id, week), bucket in buckets.items():
        metric_rows = [_metric_map(row) for row in bucket]
        combined: dict[str, Any] = {
            "week_start": next(
                (
                    _field(row, "window_start", _field(row, "week_start", _field(row, "snapshot_week_start")))
                    for row in bucket
                    if _field(row, "window_start", _field(row, "week_start", _field(row, "snapshot_week_start"))) is not None
                ),
                week if week != "unknown" else None,
            ),
            "source_ref": f"project_activity:{project_id}:{week}",
        }
        # A project-level observation is the aggregate across all repos in its
        # effective boundary. Distinct commit days are used when raw rows have
        # them; model-only rows fall back to the additive aggregate.
        commit_days: set[str] = set()
        active_day_sum = 0
        for row, metrics in zip(bucket, metric_rows):
            raw_days = _field(row, "commit_days")
            if isinstance(raw_days, Sequence) and not isinstance(raw_days, (str, bytes)):
                commit_days.update(str(day) for day in raw_days)
            elif isinstance(metrics.get("active_days"), (int, float)):
                active_day_sum += int(metrics["active_days"])
        combined["active_days"] = len(commit_days) if commit_days else active_day_sum

        def numeric_values(name: str) -> list[float]:
            return [
                float(metrics[name])
                for metrics in metric_rows
                if isinstance(metrics.get(name), (int, float)) and not isinstance(metrics.get(name), bool)
            ]

        for name, operation in (
            ("days_since_activity", min),
            ("oldest_open_pr_days", max),
            ("open_prs", sum),
            ("merged_count", sum),
        ):
            values = numeric_values(name)
            if values:
                result = operation(values)
                combined[name] = int(result) if name == "open_prs" or name == "merged_count" else result
        latency_values = numeric_values("review_latency_days")
        if latency_values:
            combined["review_latency_days"] = sum(latency_values) / len(latency_values)

        # Contributor counts cannot be de-duplicated safely across repositories
        # without retaining identities.  Only preserve the aggregate when one
        # repository is represented and it explicitly passed the floor gate.
        if len(bucket) == 1 and isinstance(metric_rows[0].get("active_contributors"), (int, float)):
            combined["active_contributors"] = int(metric_rows[0]["active_contributors"])
            if isinstance(metric_rows[0].get("team_size"), int):
                combined["team_size"] = metric_rows[0]["team_size"]
        completeness_values = numeric_values("data_completeness_pct")
        if completeness_values:
            combined["data_completeness_pct"] = min(completeness_values)
        sync_times = [
            _parse_datetime(metrics.get("last_sync_at"))
            for metrics in metric_rows
            if _parse_datetime(metrics.get("last_sync_at")) is not None
        ]
        if sync_times:
            combined["last_sync_at"] = max(sync_times)
        combined["lifecycle_state"] = _field(bucket[0], "lifecycle_state")
        grouped[project_id].append(combined)
    for records in grouped.values():
        records.sort(key=lambda item: str(item.get("week_start") or ""))
    return grouped


def _warning_evidence(result: Mapping[str, Any], project_id: str) -> list[WarningEvidenceItem]:
    evidence = result.get("evidence")
    if not isinstance(evidence, Mapping):
        return []
    observations = evidence.get("observations")
    if not isinstance(observations, Sequence) or isinstance(observations, (str, bytes)):
        return []

    references: list[EvidenceReference] = []
    for observation in observations:
        if not isinstance(observation, Mapping):
            continue
        raw_source = observation.get("source_ref")
        source_id: str | None = None
        if isinstance(raw_source, Mapping):
            value = raw_source.get("ref")
            if value not in (None, ""):
                source_id = str(value)
        elif raw_source not in (None, ""):
            source_id = str(raw_source)
        if source_id is None:
            continue
        observed_at = _parse_datetime(observation.get("last_sync_at")) or _utc_now()
        references.append(
            EvidenceReference(
                source_collection="repo_activity",
                source_id=source_id,
                source_field=str(observation.get("metric") or "aggregate_metrics"),
                observed_at=observed_at,
            )
        )

    if not references:
        return []
    return [
        WarningEvidenceItem(
            evidence_type=str(evidence.get("type", "metric")),
            icon=str(evidence.get("icon", "activity")),
            title=str(evidence.get("title", "Aggregate signal")),
            metric=str(evidence.get("metric")) if evidence.get("metric") is not None else None,
            unit=str(evidence.get("unit", "")),
            current=evidence.get("current"),
            baseline=evidence.get("baseline"),
            source_refs=references,
        )
    ]


def _warning_severity(triggered_count: int) -> WarningSeverity:
    return WarningSeverity.CRITICAL if triggered_count >= 3 else WarningSeverity.WARNING


def _trend_series(history: Sequence[Mapping[str, Any]], key: str) -> list[float | int | None]:
    """Trailing 8-week series for one metric, left-padded with None."""

    trimmed = list(history[-8:])
    padded: list[Mapping[str, Any] | None] = [None] * (8 - len(trimmed)) + trimmed
    return [None if record is None else record.get(key) for record in padded]


def _series_baseline(values: Sequence[float | int | None]) -> list[float | int | None]:
    """[earliest, latest] non-null pair a trend caption compares against."""

    observed = [value for value in values if value is not None]
    if not observed:
        return [None, None]
    return [observed[0], observed[-1]]


def _status_for_results(
    results: Mapping[str, Mapping[str, Any]],
    *,
    current: Mapping[str, Any],
    aggregation_floor: int,
) -> AttentionStatus:
    if not current:
        return AttentionStatus.INSUFFICIENT_DATA
    completeness = current.get("data_completeness_pct")
    try:
        if completeness is None or float(completeness) < 80:
            return AttentionStatus.INSUFFICIENT_DATA
    except (TypeError, ValueError):
        return AttentionStatus.INSUFFICIENT_DATA
    triggered = [
        result
        for result in results.values()
        if result.get("meets_minimum_data") and result.get("evidence")
    ]
    return (
        AttentionStatus.AT_RISK
        if len(triggered) >= 2
        else AttentionStatus.WATCH
        if triggered
        else AttentionStatus.CLEAR
    )


async def _call_sync(adapter: Any, kwargs: Mapping[str, Any]) -> SyncResult:
    sync = getattr(adapter, "sync", adapter if callable(adapter) else None)
    if sync is None:
        raise TypeError("sync adapter must expose sync() or be callable")
    try:
        result = sync(**dict(kwargs))
    except TypeError:
        try:
            signature = inspect.signature(sync)
            accepted = {name: value for name, value in kwargs.items() if name in signature.parameters}
            result = sync(**accepted) if accepted else sync()
        except (TypeError, ValueError):
            result = sync()
    if inspect.isawaitable(result):
        result = await result
    if isinstance(result, SyncResult):
        return result
    if isinstance(result, Mapping):
        return SyncResult(
            status=str(result.get("status", "ok")),
            sync_cycle_id=str(result.get("sync_cycle_id", "")),
            synced_at=str(result.get("synced_at", "")),
            records_written=int(result.get("records_written", 0) or 0),
            evidence_rows_written=int(result.get("evidence_rows_written", 0) or 0),
            repos_seen=int(result.get("repos_seen", 0) or 0),
            data_quality_flags=tuple(str(item) for item in result.get("data_quality_flags", ()) or ()),
            message=str(result["message"]) if result.get("message") else None,
        )
    raise TypeError("sync hook returned an unsupported result")


async def build_gitea_adapter(
    settings: Settings,
    database: Any,
    staging: Any,
    *,
    at: date | None = None,
) -> GiteaRepoActivityAdapter:
    """Construct the Gitea adapter with its boundary seams closed.

    Both resolvers are required for a useful result.  Without the boundary
    resolver no repository maps to a project and every snapshot degrades to
    ``insufficient_data``; without the team-size resolver the aggregation
    floor can never be satisfied and contributor signals never appear.
    """

    return GiteaRepoActivityAdapter(
        staging,
        base_url=settings.gitea_url,
        token=settings.gitea_api_token,
        organization=settings.gitea_org,
        aggregation_floor=settings.aggregation_floor,
        collection_name=REPO_ACTIVITY_STAGING_COLLECTION,
        boundary_resolver=await build_boundary_resolver(database, at=at),
        # Authentik writes its hierarchy to the raw staging store. Reading the
        # resolver from that same store also works in local in-memory runs.
        team_size_resolver=await build_team_size_resolver(staging, at=at, boundaries=database),
    )


async def build_gitea_adapters(
    settings: Settings,
    database: Any,
    staging: Any,
    *,
    at: date | None = None,
) -> list[GiteaRepoActivityAdapter]:
    """Construct one Gitea adapter per org to sync.

    ``PHI_GITEA_ORG`` names a single org when set, preserving the original
    single-org deployment shape. Left unset, the orgs to sync are instead
    every distinct explicit Gitea organization recorded on a People Portal
    catalog boundary. Legacy boundaries may still use their root-team value
    as the configured organization.
    """

    if settings.gitea_org:
        return [await build_gitea_adapter(settings, database, staging, at=at)]

    boundary_resolver = await build_boundary_resolver(database, at=at)
    team_size_resolver = await build_team_size_resolver(staging, at=at, boundaries=database)
    boundaries = await database.list("boundaries")
    orgs = sorted({
        getattr(boundary, "gitea_organization", None)
        or getattr(boundary, "root_shared_resource_id", None)
        or getattr(boundary, "root_authentik_team_id", None)
        for boundary in boundaries
        if (
            getattr(boundary, "gitea_organization", None)
            or getattr(boundary, "root_shared_resource_id", None)
            or getattr(boundary, "root_authentik_team_id", None)
        )
    })
    return [
        GiteaRepoActivityAdapter(
            staging,
            base_url=settings.gitea_url,
            token=settings.gitea_api_token,
            organization=org,
            aggregation_floor=settings.aggregation_floor,
            collection_name=REPO_ACTIVITY_STAGING_COLLECTION,
            boundary_resolver=boundary_resolver,
            team_size_resolver=team_size_resolver,
        )
        for org in orgs
    ]


async def run_nightly_sync(
    settings: Settings | None = None,
    database: Any = None,
    *,
    staging: Any = None,
    authentik_adapter: Any = None,
    gitea_adapter: Any = None,
    now: datetime | None = None,
    lookback_days: int = 14,
) -> dict[str, Any]:
    """Run nightly pulls; missing endpoints are a normal no-op status."""

    settings = settings or get_settings()
    database = database or get_active_repository()
    owns_staging = staging is None
    staging = staging or open_staging_store(settings)
    started = now or _utc_now()
    cycle_id = f"sync_{started.strftime('%Y%m%d%H%M%S')}_{started.microsecond}"
    directory_source = "people_portal" if settings.people_portal_url else "authentik"
    if authentik_adapter is None:
        if settings.people_portal_url:
            people_portal_sdk = PeoplePortalSdkClient(
                base_url=settings.people_portal_url,
                token=settings.people_portal_api_token or "",
            )
            authentik_adapter = PeoplePortalDirectoryAdapter(
                staging,
                base_url=settings.people_portal_url,
                token=settings.people_portal_api_token,
                sdk_client=people_portal_sdk,
                aggregation_floor=settings.aggregation_floor,
            )
        else:
            authentik_adapter = AuthentikTeamHierarchyAdapter(
                staging,
                base_url=settings.authentik_url,
                token=settings.authentik_api_token,
                aggregation_floor=settings.aggregation_floor,
            )
    try:
        # The team pull runs first: the Gitea adapter's floor gate reads the
        # sizes it stages, so building that adapter earlier would resolve
        # every team size to None on a first run.
        team_result = await _call_sync(
            authentik_adapter,
            {"sync_cycle_id": cycle_id, "synced_at": _iso(started)},
        )
        catalog_result = (
            await fold_people_portal_catalog(database, staging)
            if directory_source == "people_portal" and team_result.status != "not_configured"
            else None
        )
        gitea_adapters = [gitea_adapter] if gitea_adapter is not None else await build_gitea_adapters(
            settings,
            database,
            staging,
            at=started.date(),
        )
        # Windows are ISO-week aligned rather than a rolling lookback: an
        # activity row is bucketed by the lower bound it was given, and a
        # rolling bound would land between weeks and never match the week
        # being snapshotted.  Recent whole weeks are re-pulled so that
        # late-arriving reviews and merges still land in their own week.
        weeks_back = max(1, ceil(max(0, int(lookback_days)) / 7) or 1)
        repo_results: list[SyncResult] = []
        for adapter in gitea_adapters:
            for window_start, window_end in _week_windows(weeks_back, through=started.date()):
                repo_results.append(
                    await _call_sync(
                        adapter,
                        {
                            "sync_cycle_id": f"{cycle_id}_{window_start.isoformat()}",
                            "synced_at": _iso(started),
                            "since": datetime.combine(window_start, datetime.min.time(), tzinfo=timezone.utc),
                            "until": min(started, datetime.combine(window_end, datetime.max.time(), tzinfo=timezone.utc)),
                            "backfill": False,
                        },
                    )
                )
        repo_result = _merge_sync_results(repo_results)
        fold_result = await fold_staging_activity(database, staging)
        statuses = {team_result.status, repo_result.status}
        return {
            "status": (
                "ok"
                if statuses == {"ok"}
                else "not_configured"
                if statuses == {"not_configured"}
                else "partial"
            ),
            "sync_cycle_id": cycle_id,
            "directory_source": directory_source,
            "directory": team_result.as_dict(),
            "authentik": team_result.as_dict() if directory_source == "authentik" else None,
            "people_portal": team_result.as_dict() if directory_source == "people_portal" else None,
            "project_catalog": catalog_result,
            "gitea": repo_result.as_dict(),
            "fold": fold_result,
            "outbound_notifications": False,
        }
    finally:
        for adapter in (authentik_adapter, gitea_adapter):
            closer = getattr(adapter, "close", None)
            if closer is not None:
                closer()
        if owns_staging:
            closer = getattr(staging, "close", None)
            if closer is not None:
                closer()


def _merge_sync_results(results: Sequence[SyncResult]) -> SyncResult:
    """Combine per-window sync results into one reportable outcome."""

    if not results:
        return SyncResult(status="not_configured", sync_cycle_id="", synced_at="")
    statuses = {result.status for result in results}
    status = "ok" if statuses == {"ok"} else "not_configured" if statuses == {"not_configured"} else "partial"
    flags: list[str] = []
    for result in results:
        flags.extend(result.data_quality_flags)
    return SyncResult(
        status=status,
        sync_cycle_id=results[-1].sync_cycle_id,
        synced_at=results[-1].synced_at,
        records_written=sum(result.records_written for result in results),
        evidence_rows_written=sum(result.evidence_rows_written for result in results),
        repos_seen=max(result.repos_seen for result in results),
        data_quality_flags=tuple(sorted(set(flags))),
    )


def _week_windows(weeks: int, *, through: date) -> list[tuple[date, date]]:
    """Return ``weeks`` consecutive Monday-start windows ending at ``through``.

    The most recent window is the ISO week containing ``through``; earlier
    windows run backwards from it.  Windows are returned oldest first so the
    resulting history is appended in chronological order.
    """

    if weeks <= 0:
        raise ValueError("weeks must be a positive integer")
    latest_start = through - timedelta(days=through.weekday())
    windows = [
        (latest_start - timedelta(weeks=offset), latest_start - timedelta(weeks=offset) + timedelta(days=6))
        for offset in range(weeks)
    ]
    return list(reversed(windows))


async def run_weekly_backfill(
    settings: Settings | None = None,
    database: Any = None,
    *,
    staging: Any = None,
    gitea_adapter: Any = None,
    weeks: int = 10,
    through: date | None = None,
    generate_snapshots: bool = True,
    rule_set_version: str | None = None,
) -> dict[str, Any]:
    """Replay Gitea history one week at a time, then snapshot each week.

    A single wide-range replay is not sufficient to seed baselines.  The
    activity row records ``window_start`` from the lower bound it was given,
    so one call over ten weeks produces one observation, and the rule engine
    requires at least four *prior* weekly observations before any signal
    clears its minimum-data gate.  Each week is therefore pulled as its own
    bounded window, and snapshots are generated in chronological order so that
    every week sees only the history that preceded it.
    """

    settings = settings or get_settings()
    database = database or get_active_repository()
    owns_staging = staging is None
    staging = staging or open_staging_store(settings)
    owns_adapter = gitea_adapter is None
    windows = _week_windows(weeks, through=through or _utc_now().date())
    started = _utc_now()

    week_results: list[dict[str, Any]] = []
    snapshots_created = 0
    try:
        for window_start, window_end in windows:
            if gitea_adapter is not None:
                adapters = [gitea_adapter]
            else:
                # Boundaries are resolved as of the window being replayed, so
                # a historical week uses the boundary version in force then.
                adapters = await build_gitea_adapters(
                    settings,
                    database,
                    staging,
                    at=window_start,
                )
            cycle_id = f"backfill_{window_start.isoformat()}_{started.strftime('%H%M%S')}"
            since = datetime.combine(window_start, datetime.min.time(), tzinfo=timezone.utc)
            until = datetime.combine(window_end, datetime.max.time(), tzinfo=timezone.utc)
            week_repo_results: list[SyncResult] = []
            try:
                for adapter in adapters:
                    week_repo_results.append(
                        await _call_sync(
                            adapter,
                            {
                                "sync_cycle_id": cycle_id,
                                "synced_at": _iso(started),
                                "since": since,
                                "until": until,
                                "backfill": True,
                            },
                        )
                    )
            finally:
                if owns_adapter:
                    for adapter in adapters:
                        closer = getattr(adapter, "close", None)
                        if closer is not None:
                            closer()
            result = _merge_sync_results(week_repo_results)
            week_results.append({"week_start": window_start.isoformat(), **result.as_dict()})

        fold_result = await fold_staging_activity(database, staging)

        if generate_snapshots:
            for window_start, _ in windows:
                snapshots_created += await generate_weekly_snapshots(
                    settings=settings,
                    database=database,
                    week_start=window_start,
                    rule_set_version=rule_set_version,
                )

        statuses = {entry.get("status") for entry in week_results}
        return {
            "status": "ok" if statuses == {"ok"} else "not_configured" if statuses == {"not_configured"} else "partial",
            "job": "weekly_backfill",
            "weeks_requested": weeks,
            "weeks": week_results,
            "fold": fold_result,
            "snapshots_written": snapshots_created,
            "outbound_notifications": False,
        }
    finally:
        if owns_staging:
            closer = getattr(staging, "close", None)
            if closer is not None:
                closer()


async def run_historical_backfill(
    adapter: Any,
    *,
    start_at: date | datetime | str | None = None,
    end_at: date | datetime | str | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """Run an explicit historical Gitea replay as a new append-only cycle."""

    captured = now or _utc_now()
    result = await _call_sync(
        adapter,
        {
            "start_at": start_at,
            "end_at": end_at,
            "backfill": True,
            "synced_at": _iso(captured),
        },
    )
    return {"status": result.status, "job": "historical_backfill", **result.as_dict()}


async def generate_weekly_snapshots(
    settings: Settings | None = None,
    database: Any = None,
    week_start: date | None = None,
    rule_set_version: str | None = None,
) -> int:
    """Append one immutable, evidence-backed snapshot per project."""

    settings = settings or get_settings()
    database = database or get_active_repository()
    now = _utc_now()
    week_start = week_start or now.date() - timedelta(days=now.weekday())
    week_end = week_start + timedelta(days=6)
    version = rule_set_version or settings.rule_set_version
    projects = await database.list("projects")
    activity_rows = await database.list("repo_activity")
    existing_snapshots = await database.list("snapshots")
    existing_keys = {
        (str(snapshot.project_id), snapshot.week_start, str(snapshot.rule_set_version))
        for snapshot in existing_snapshots
    }
    histories = _history_by_project(activity_rows)
    created = 0

    for project in projects:
        project_id = str(project.project_id)
        if (project_id, week_start, version) in existing_keys:
            # Snapshot identity is unique at this grain. A scheduler retry or
            # overlapping backfill is therefore a successful no-op, while a
            # new rule-set version still appends a new immutable record.
            continue
        decision = project.scoring_decision(week_start, week_end)
        # History is truncated at the week being generated so that replaying
        # past weeks scores each one against only the data that preceded it.
        # Without this a backfill would score every historical week using the
        # newest observation and emit identical warnings for all of them.
        history = [
            record
            for record in histories.get(project_id, [])
            if _record_week(record) is not None and _record_week(record) <= week_start
        ]
        # A current empty record keeps the rule engine's insufficient-data
        # status explicit instead of allowing an empty history to look clear.
        if not history or _record_week(history[-1]) != week_start:
            history = history + [{"week_start": week_start, "data_completeness_pct": 0, "source_ref": f"missing:{project_id}:{week_start}"}]
        current = history[-1]
        rule_input = {
            "weeks": history,
            "current": current,
            "lifecycle_state": project.lifecycle_state.value,
        }
        results = evaluate_mvp_rules(
            rule_input,
            aggregation_floor=settings.aggregation_floor,
        )

        if decision.suppressed:
            status = decision.status or AttentionStatus.INSUFFICIENT_DATA
            results = {}
        else:
            status = _status_for_results(
                results,
                current=current,
                aggregation_floor=settings.aggregation_floor,
            )

        metrics_payload = {
            key: value
            for key, value in _metric_map(current).items()
            if key
            in {
                "active_days",
                "days_since_activity",
                "open_prs",
                "oldest_open_pr_days",
                "review_latency_days",
                "merged_count",
                "active_contributors",
                "team_size",
                "aggregation_floor",
                "data_completeness_pct",
                "last_sync_at",
            }
        }
        if "active_contributors" in metrics_payload:
            team_size = metrics_payload.get("team_size")
            if not isinstance(team_size, int) or team_size < settings.aggregation_floor:
                metrics_payload.pop("active_contributors", None)
                metrics_payload.pop("team_size", None)
        metrics_payload["data_completeness_pct"] = float(metrics_payload.get("data_completeness_pct", 0) or 0)
        metrics_payload["last_sync_at"] = _parse_datetime(metrics_payload.get("last_sync_at"))
        metrics = AggregateMetrics(**metrics_payload)

        series: dict[str, list[float | int | None]] = {
            "activity": _trend_series(history, "active_days"),
            "open_prs": _trend_series(history, "open_prs"),
            "review_latency": _trend_series(history, "review_latency_days"),
        }
        contributors_series = _trend_series(history, "active_contributors")
        if "active_contributors" in metrics_payload:
            series["contributors"] = contributors_series
        series_baselines = {
            "open_prs": _series_baseline(series["open_prs"]),
            "review_latency": _series_baseline(series["review_latency"]),
        }
        if "contributors" in series:
            series_baselines["contributors"] = _series_baseline(series["contributors"])

        warning_documents: list[WarningDocument] = []
        triggered_count = sum(1 for result in results.values() if result.get("meets_minimum_data") and result.get("evidence"))
        snapshot_id = new_id()
        for rule_id, result in results.items():
            if not result.get("meets_minimum_data") or not result.get("evidence"):
                continue
            evidence_items = _warning_evidence(result, project_id)
            if not evidence_items:
                # A warning without an inspectable evidence row is a bug; do
                # not persist the warning or downgrade it to an unexplained UI
                # signal.
                raise ValueError(f"rule {rule_id} produced no source evidence")
            evidence = result["evidence"]
            warning_documents.append(
                _document(WarningDocument,
                    id=new_id(),
                    snapshot_id=snapshot_id,
                    project_id=project_id,
                    rule_id=rule_id,
                    rule_version=version,
                    signal_name=str(evidence.get("title", rule_id)),
                    current_value=result.get("value"),
                    baseline_value=result.get("baseline"),
                    time_window=str(result.get("window", "")),
                    trigger_threshold=(evidence.get("trigger") or {}).get("threshold"),
                    severity=_warning_severity(triggered_count),
                    explanation=str(evidence.get("title", "Aggregate rule triggered")),
                    data_freshness=str(current.get("last_sync_at") or "unknown"),
                    data_completeness_pct=float(current.get("data_completeness_pct", 0) or 0),
                    evidence=evidence_items,
                )
            )

        snapshot = _document(WeeklySnapshotDocument,
            id=str(snapshot_id),
            project_id=project_id,
            week_start=week_start,
            week_end=week_end,
            rule_set_version=version,
            generated_at=now,
            attention_status=status,
            data_completeness_pct=metrics.data_completeness_pct or 0,
            last_sync_at=metrics.last_sync_at,
            metrics=metrics,
            baselines=None,
            warning_ids=[warning.id for warning in warning_documents if warning.id is not None],
            series=series,
            series_baselines=series_baselines,
        )
        for warning in warning_documents:
            await database.add("warnings", warning)
        # This is intentionally add/insert only. No existing snapshot is read
        # or mutated, so reruns remain new historical records with a version.
        await database.add("snapshots", snapshot)
        existing_keys.add((project_id, week_start, version))
        created += 1
    return created


async def run_weekly_snapshot_job(
    settings: Settings | None = None,
    database: Any = None,
    *,
    week_start: date | None = None,
    rule_set_version: str | None = None,
    engine: str | None = None,
) -> dict[str, Any]:
    """Compute a completed week's portfolio snapshot -- the weekly-cron entrypoint.

    Defaults to the most recently completed ISO week. Disabled LLM mode uses
    rules; enabled but misconfigured LLM mode fails explicitly. Provider
    failures remain retryable and never create a rule verdict labeled LLM.
    """
    settings = settings or get_settings()
    database = database or get_active_repository()
    resolved_engine = engine or ("llm" if settings.llm_enabled else "rules")
    if resolved_engine not in {"llm", "rules"}:
        raise ValueError("engine must be 'llm' or 'rules'")
    today = _utc_now().date()
    week_start = week_start or (_iso_week_start(today) - timedelta(weeks=1))
    if week_start.weekday() != 0 or week_start + timedelta(days=6) >= today:
        raise ValueError("weekly jobs require a completed ISO week starting on Monday")
    if resolved_engine == "llm":
        created = await generate_llm_weekly_snapshots(settings=settings, database=database, week_start=week_start)
    else:
        created = await generate_weekly_snapshots(
            settings=settings,
            database=database,
            week_start=week_start,
            rule_set_version=rule_set_version,
        )
    failed_projects = []
    if resolved_engine == "llm":
        available = {str(s.project_id) for s in await database.list("snapshots")
                     if s.week_start == week_start and s.rule_set_version == SIGNAL_VERSION}
        failed_projects = [str(p.project_id) for p in await database.list("projects")
                           if str(p.project_id) not in available]
    return {
        "status": "partial" if failed_projects else "ok",
        "job": "weekly_snapshot",
        "engine": resolved_engine,
        "snapshots_written": created,
        "failed_project_ids": failed_projects,
        "outbound_notifications": False,
    }


# ---------------------------------------------------------------------------
# LLM-judged weekly signal (backend.signal_llm) -- lazy per-project-week
# ---------------------------------------------------------------------------

_LLM_SNAPSHOT_LOCKS: WeakValueDictionary = WeakValueDictionary()
_LLM_SNAPSHOT_LOCKS_GUARD = asyncio.Lock()


async def _llm_snapshot_lock(key: tuple[str, date]) -> asyncio.Lock:
    async with _LLM_SNAPSHOT_LOCKS_GUARD:
        return _LLM_SNAPSHOT_LOCKS.setdefault(key, asyncio.Lock())


async def build_code_evidence_reader(
    settings: Settings,
    database: Any,
    project_id: str,
    *,
    at: date,
) -> tuple[GiteaCodeEvidenceReader, list[str]] | None:
    """Resolve a project's repos/org as of ``at`` and build a diff reader for them.

    Point-in-time, like ``build_gitea_adapters``: a repo added to the
    boundary after the week being judged must not leak into that week's
    evidence. Returns ``None`` (no network call made) when there's no
    boundary or it maps to zero repos.
    """
    boundary = await database.boundary_at(project_id, at)
    if boundary is None:
        return None
    excluded = set(getattr(boundary, "excluded_repos", None) or [])
    repo_slugs = [
        ref.repo_slug
        for ref in list(boundary.primary_repos) + list(getattr(boundary, "shared_repos", None) or [])
        if ref.repo_slug not in excluded
    ]
    repo_slugs = list(dict.fromkeys(repo_slugs))
    if not repo_slugs:
        return None
    org = (
        settings.gitea_org
        or getattr(boundary, "gitea_organization", None)
        or getattr(boundary, "root_shared_resource_id", None)
        or boundary.root_authentik_team_id
    )
    reader = GiteaCodeEvidenceReader(base_url=settings.gitea_url, token=settings.gitea_api_token, organization=org)
    return reader, repo_slugs


def _latest_llm_snapshot(snapshots: Sequence[Any], project_id: str, before: date) -> Any | None:
    candidates = [
        snap for snap in snapshots
        if str(snap.project_id) == project_id and snap.rule_set_version == SIGNAL_VERSION and snap.week_start < before
    ]
    return max(candidates, key=lambda snap: (snap.week_start, snap.generated_at), default=None)


def _severity_enum(value: str) -> WarningSeverity:
    return {
        "info": WarningSeverity.INFO,
        "warning": WarningSeverity.WARNING,
        "critical": WarningSeverity.CRITICAL,
    }.get(value, WarningSeverity.INFO)


async def generate_llm_snapshot(
    project_id: str,
    week_start: date,
    *,
    settings: Settings | None = None,
    database: Any = None,
    judge: WeeklySignalJudge | None = None,
    persist: bool = True,
    through_date: date | None = None,
) -> WeeklySnapshotDocument | None:
    """Compute, or return the already-cached, LLM-judged snapshot for one project-week.

    ``None`` means nothing could be computed and nothing was persisted --
    ``weekly_snapshots`` is immutable, so a failed judgment is deliberately
    never written; a later retry can still produce a real verdict. This is
    the function the "Compute this week" button and the weekly cron both
    call; the per-(project, week) lock means two concurrent callers pay for
    at most one provider call.

    ``persist=False`` computes and returns a snapshot without writing
    anything to the database -- used by ``generate_cumulative_checkpoint``
    when the deep tail includes the current, still-in-progress ISO week:
    ``weekly_snapshots`` is immutable, so caching a partial week as if it
    were final would freeze a wrong verdict for the rest of the week.
    """
    settings = settings or get_settings()
    database = database or get_active_repository()
    if week_start.weekday() != 0:
        raise ValueError("week_start must be a Monday")
    today = _utc_now().date()
    week_end = min(week_start + timedelta(days=6), through_date or today, today)
    if week_end < week_start:
        raise ValueError("cannot compute a future week")
    complete_week = week_end == week_start + timedelta(days=6) and week_end < today
    persist = persist and complete_week

    lock = await _llm_snapshot_lock((id(database), project_id, week_start))
    async with lock:
        all_snapshots = await database.list("snapshots")
        existing = [
            snap for snap in all_snapshots
            if str(snap.project_id) == project_id and snap.week_start == week_start and snap.rule_set_version == SIGNAL_VERSION
        ]
        if existing and complete_week:
            return existing[0]

        project = await database.get_project(project_id)
        if project is None:
            return None
        now = _utc_now()
        decision = project.scoring_decision(week_start, week_end)
        if decision.suppressed:
            snapshot = _document(
                WeeklySnapshotDocument,
                id=str(new_id()),
                project_id=project_id,
                week_start=week_start,
                week_end=week_end,
                rule_set_version=SIGNAL_VERSION,
                generated_at=now,
                attention_status=decision.status or AttentionStatus.PLANNED_PAUSE,
                data_completeness_pct=0,
                last_sync_at=None,
                metrics=AggregateMetrics(),
                baselines=None,
                warning_ids=[],
                series={},
                series_baselines={},
                signal_source="llm",
                signal_headline="Planned pause",
                signal_summary="This project has a recorded pause for this week; signals are suppressed by policy.",
                signal_confidence=1.0,
                signal_work_volume="none",
            )
            if persist:
                await database.add("snapshots", snapshot)
            return snapshot

        is_new_project = not any(str(snap.project_id) == project_id and snap.week_start < week_start for snap in all_snapshots)
        boundary = await database.boundary_at(project_id, week_start)
        if boundary is None:
            boundary = await database.boundary_at(project_id, week_end)
        evidence_start = max(week_start, boundary.effective_from) if boundary else week_start
        built = await build_code_evidence_reader(settings, database, project_id, at=evidence_start)
        evidence = None
        if built is not None:
            reader, repo_slugs = built
            def read_week():
                try:
                    return reader.week_evidence(
                        project_id=project_id, repo_slugs=repo_slugs, week_start=evidence_start, week_end=week_end
                    )
                finally:
                    closer = getattr(reader, "close", None)
                    if closer is not None:
                        closer()
            try:
                evidence = await anyio.to_thread.run_sync(read_week, abandon_on_cancel=True)
            except Exception:
                return None

        prior_doc = _latest_llm_snapshot(all_snapshots, project_id, week_start)
        prior_signal = None
        if prior_doc is not None and prior_doc.signal_headline:
            prior_signal = WeeklySignal(
                status=prior_doc.attention_status,
                confidence=prior_doc.signal_confidence or 0.5,
                headline=prior_doc.signal_headline,
                summary=prior_doc.signal_summary or "",
                work_volume=prior_doc.signal_work_volume or "none",
            )

        if evidence is None:
            # A corrected mapping must be able to retry the same week.
            return None
        else:
            judge = judge if judge is not None else get_signal_judge(settings)
            signal = await judge_project_week(
                evidence,
                project_name=project.display_name,
                lifecycle=project.lifecycle_state.value,
                judge=judge,
                prior=prior_signal,
                is_new_project=is_new_project,
            )

        if signal.is_failure:
            return None

        non_noise = evidence.non_noise_commits if evidence else []
        commit_dates = {commit.committed_at.date() for commit in non_noise if commit.committed_at}
        active_days = len(commit_dates)
        last_commit_date = max(commit_dates, default=None)
        days_since_activity = max(0, (week_end - last_commit_date).days) if last_commit_date else None
        if evidence is None:
            completeness = 0.0
        elif not non_noise:
            completeness = 100.0
        else:
            errors = evidence.total_fetch_errors
            completeness = round(max(0.0, min(100.0, (1.0 - errors / len(non_noise)) * 100)), 1)

        # The code-evidence reader is commit-only, so the pull-request
        # aggregates have to come from the repo_activity rows the Gitea sync
        # already wrote for this same week. Without this the "Project
        # aggregates" panel renders "--" for counts that were really synced,
        # including legitimate zeros.
        week_rows = [
            row
            for row in await database.list("repo_activity")
            if str(_field(row, "project_id")) == project_id
            and _field(row, "window_start") == week_start
        ]
        # ``repo_activity`` is a one-row-per-(project, repo, week) projection
        # (see ``fold_staging_activity``); fold additively over a duplicated
        # key and the week's active_days doubles.  Collapse to the best row
        # per repo before folding so a stray duplicate cannot inflate it.
        existing_activity = _best_activity_by_repo(week_rows)
        week_activity = list(existing_activity.values())
        folded = _history_by_project(week_activity).get(project_id) if week_activity else None
        pr_metrics = {
            key: value
            for key, value in (folded[-1] if folded else {}).items()
            if key in ("open_prs", "merged_count", "oldest_open_pr_days", "review_latency_days")
        }

        metrics = AggregateMetrics(
            active_days=active_days,
            days_since_activity=days_since_activity,
            data_completeness_pct=completeness,
            last_sync_at=now,
            **pr_metrics,
        )

        history = sorted(
            (
                snap for snap in all_snapshots
                if str(snap.project_id) == project_id and snap.week_start < week_start
            ),
            key=lambda snap: (snap.week_start, snap.generated_at),
        )[-7:]
        activity_series: list[float | int | None] = [
            (snap.metrics.active_days if snap.metrics else None) for snap in history
        ] + [active_days]
        activity_series = ([None] * max(0, 8 - len(activity_series)) + activity_series)[-8:]

        snapshot_id = new_id()
        warning_documents: list[WarningDocument] = []
        repo_documents: list[RepoActivityDocument] = []
        # A placeholder id lets concern->evidence linking work identically
        # whether or not the repo_activity row actually gets written below.
        repo_activity_ids: dict[str, str] = {}
        if evidence is not None:
            for repo in evidence.repos:
                # ``repo_activity`` holds exactly one row per (project, repo,
                # week).  When the Gitea sync already wrote this week's row,
                # point the evidence at it and write nothing: a second,
                # commit-only row would carry no pull-request aggregates,
                # double-count active_days in every additive fold, and shadow
                # the synced row for anything that reads an arbitrary match.
                existing_row = existing_activity.get(repo.repo_slug)
                if existing_row is not None:
                    existing_id = _record_id(existing_row)
                    if existing_id:
                        repo_activity_ids[repo.repo_slug] = existing_id
                        continue
                repo_active_days = len({
                    commit.committed_at.date()
                    for commit in repo.commits
                    if commit.committed_at and not commit.is_noise_only
                })
                repo_doc = _document(
                    RepoActivityDocument,
                    id=str(new_id()),
                    project_id=project_id,
                    gitea_repo_id=repo.repo_slug,
                    repo_slug=repo.repo_slug,
                    window_start=week_start,
                    window_end=week_end,
                    synced_at=now,
                    active_days=repo_active_days,
                    data_completeness_pct=completeness,
                    last_sync_at=now,
                )
                repo_documents.append(repo_doc)
                repo_activity_ids[repo.repo_slug] = str(repo_doc.id)

            fallback_repo_id = next(iter(repo_activity_ids.values()), None)
            for concern in signal.concerns:
                refs = concern.get("evidence") or []
                ref_repo = refs[0].split("@")[0].split("/")[0] if refs else None
                source_id = repo_activity_ids.get(ref_repo) or fallback_repo_id
                if source_id is None:
                    continue
                warning_documents.append(
                    _document(
                        WarningDocument,
                        id=str(new_id()),
                        snapshot_id=str(snapshot_id),
                        project_id=project_id,
                        rule_id="llm.weekly_signal",
                        rule_version=SIGNAL_VERSION,
                        signal_name=str(concern["text"])[:160],
                        current_value=None,
                        baseline_value=None,
                        time_window=f"{week_start.isoformat()}..{week_end.isoformat()}",
                        trigger_threshold=None,
                        severity=_severity_enum(concern["severity"]),
                        explanation=str(concern["text"]),
                        data_freshness=now.isoformat(),
                        data_completeness_pct=completeness,
                        evidence=[
                            WarningEvidenceItem(
                                evidence_type="llm_signal",
                                icon="sparkle",
                                title=str(concern["text"])[:240],
                                metric="llm_concern",
                                current=concern["severity"],
                                source_refs=[
                                    EvidenceReference(
                                        source_collection="repo_activity",
                                        source_id=source_id,
                                        source_field="commits",
                                        observed_at=now,
                                    )
                                ],
                            )
                        ],
                    )
                )

        snapshot = _document(
            WeeklySnapshotDocument,
            id=str(snapshot_id),
            project_id=project_id,
            week_start=week_start,
            week_end=week_end,
            rule_set_version=SIGNAL_VERSION,
            generated_at=now,
            attention_status=signal.status,
            data_completeness_pct=metrics.data_completeness_pct or 0,
            last_sync_at=now,
            metrics=metrics,
            baselines=None,
            warning_ids=[warning.id for warning in warning_documents if warning.id is not None],
            series={"activity": activity_series},
            series_baselines={},
            signal_source="llm",
            signal_headline=signal.headline,
            signal_summary=signal.summary,
            signal_confidence=signal.confidence,
            signal_work_volume=signal.work_volume,
            signal_model=signal.model,
            signal_recommendations=signal.recommendations,
            signal_changes=signal.what_changed,
            signal_concerns=signal.concerns,
            signal_data_gaps=signal.data_gaps,
            signal_evidence_tier=evidence.tier if evidence else None,
            signal_facts=[
                {
                    "kind": "commit",
                    "repo_slug": commit.repo_slug,
                    "sha": commit.sha,
                    "subject": commit.subject,
                    "files_changed": len(commit.files),
                    "additions": commit.additions,
                    "deletions": commit.deletions,
                }
                for commit in non_noise
            ][:60],
        )
        if persist:
            async with database.transaction():
                for repo_doc in repo_documents:
                    await database.add("repo_activity", repo_doc)
                for warning in warning_documents:
                    await database.add("warnings", warning)
                await database.add("snapshots", snapshot)
        return snapshot


async def generate_llm_weekly_snapshots(
    settings: Settings | None = None,
    database: Any = None,
    *,
    week_start: date | None = None,
    concurrency: int = 3,
) -> int:
    """Compute the LLM signal for every project for a completed week.

    Cache-read-before-compute in ``generate_llm_snapshot`` makes a mid-week
    rerun a no-op for projects already computed -- "held for the week" falls
    out of that for free, no extra flag needed.
    """
    settings = settings or get_settings()
    database = database or get_active_repository()
    now = _utc_now()
    week_start = week_start or (_iso_week_start(now.date()) - timedelta(weeks=1))
    if week_start.weekday() != 0 or week_start + timedelta(days=6) >= now.date():
        raise ValueError("weekly jobs require a completed ISO week starting on Monday")
    projects = await database.list("projects")
    judge = get_signal_judge(settings)
    if judge is None:
        raise LLMUnavailable("LLM weekly signal requires an enabled provider, API key, and installed SDK")
    cached_projects = {
        str(s.project_id) for s in await database.list("snapshots")
        if s.week_start == week_start and s.rule_set_version == SIGNAL_VERSION
    }
    semaphore = asyncio.Semaphore(max(1, concurrency))
    written = 0
    lock = asyncio.Lock()

    async def _run(project_id: str) -> None:
        nonlocal written
        if project_id in cached_projects:
            return
        async with semaphore:
            try:
                result = await asyncio.wait_for(
                    generate_llm_snapshot(project_id, week_start, settings=settings, database=database, judge=judge),
                    timeout=settings.lazy_compute_timeout_seconds,
                )
            except Exception:
                return
            if result is not None:
                async with lock:
                    written += 1

    await asyncio.gather(*(_run(str(project.project_id)) for project in projects))
    return written


_LOGGER = logging.getLogger(__name__)


def _log_llm_unavailable(judge: str, settings: Settings, exc: Exception | None = None) -> None:
    """Explain, once per construction attempt, why enrichment will not run.

    Enrichment is optional and degrading to deterministic scoring is correct,
    but a *silent* degrade hides misconfiguration indefinitely -- an enabled
    flag with no key reads exactly like a healthy deterministic run. The
    numeric scoring path is unaffected either way; this only makes the reason
    visible.
    """

    if exc is not None:
        _LOGGER.warning("%s: LLM enrichment unavailable (%s: %s)", judge, type(exc).__name__, exc)
    elif settings.llm_enabled:
        _LOGGER.warning(
            "%s: PHI_LLM_ENABLED is true but no Gemini API key is configured; "
            "set PHI_GEMINI_API_KEY to enable enrichment. Falling back to deterministic scoring.",
            judge,
        )
    else:
        _LOGGER.info("%s: LLM enrichment disabled (PHI_LLM_ENABLED is false).", judge)


def get_signal_judge(settings: Settings) -> WeeklySignalJudge | None:
    """Build a ``WeeklySignalJudge`` if LLM enrichment is configured, else ``None``."""
    if not settings.llm_active:
        _log_llm_unavailable("weekly signal judge", settings)
        return None
    try:
        from .llm import GeminiStructuredLLM

        llm = GeminiStructuredLLM(api_key=settings.gemini_api_key, timeout_s=settings.llm_signal_timeout_seconds)  # type: ignore[arg-type]
        return WeeklySignalJudge(llm, model=settings.signal_model)
    except Exception as exc:
        _log_llm_unavailable("weekly signal judge", settings, exc)
        return None


def get_cumulative_judge(settings: Settings) -> CumulativeCheckpointJudge | None:
    """Build a ``CumulativeCheckpointJudge`` if LLM enrichment is configured, else ``None``."""
    if not settings.llm_active:
        _log_llm_unavailable("cumulative checkpoint judge", settings)
        return None
    try:
        from .llm import GeminiStructuredLLM

        llm = GeminiStructuredLLM(api_key=settings.gemini_api_key, timeout_s=settings.llm_signal_timeout_seconds)  # type: ignore[arg-type]
        return CumulativeCheckpointJudge(llm, model=settings.cumulative_model)
    except Exception as exc:
        _log_llm_unavailable("cumulative checkpoint judge", settings, exc)
        return None


# ---------------------------------------------------------------------------
# Cumulative progress-as-of-date (backend.cumulative_llm) -- lazy, per
# (project, as-of-date), automatically fanned out client-side across the
# whole portfolio when a date is picked on the Projects page.
# ---------------------------------------------------------------------------

_CUMULATIVE_LOCKS: WeakValueDictionary = WeakValueDictionary()
_CUMULATIVE_LOCKS_GUARD = asyncio.Lock()


async def _cumulative_lock(key: tuple[str, date]) -> asyncio.Lock:
    async with _CUMULATIVE_LOCKS_GUARD:
        return _CUMULATIVE_LOCKS.setdefault(key, asyncio.Lock())


def _iso_week_start(value: date) -> date:
    return value - timedelta(days=value.weekday())


def _checkpoint_to_context(doc: CumulativeCheckpointDocument) -> CumulativeCheckpoint:
    """Reconstruction of a persisted checkpoint for use as prior context.

    Carries milestones/open_concerns too: on the incremental ("warm") path
    the prior checkpoint is the only record of everything before the newly
    judged weeks, so dropping its grounded findings leaves the synthesis
    with nothing to build on.
    """
    return CumulativeCheckpoint(
        status=doc.status,
        confidence=doc.confidence,
        trajectory=doc.trajectory,
        headline=doc.headline,
        narrative=doc.narrative,
        work_to_date=doc.work_to_date,
        milestones=list(doc.milestones),
        open_concerns=list(doc.open_concerns),
    )


def _warnings_to_concerns(warnings: Sequence[Any], week_start: date) -> list[dict[str, Any]]:
    """Rebuild a week's ``concerns`` from the ``WarningDocument`` rows it wrote.

    The concern *text* and severity survive persistence; the LLM's original
    ``repo/path@sha`` evidence strings do not (a warning's ``source_refs``
    point at ``repo_activity`` rows instead), so each concern is grounded
    with the plain week reference the cumulative prompt's rule 4 allows.
    """
    concerns: list[dict[str, Any]] = []
    for warning in warnings:
        text = str(_field(warning, "explanation") or _field(warning, "signal_name") or "").strip()
        if not text:
            continue
        severity = _field(warning, "severity")
        concerns.append({
            "text": text[:240],
            "severity": getattr(severity, "value", str(severity or "info")),
            "evidence": [f"week {week_start.isoformat()}"],
        })
    return concerns


def _snapshot_to_weekly_signal(
    snapshot: WeeklySnapshotDocument,
    concerns: Sequence[dict[str, Any]] | None = None,
) -> WeeklySignal:
    """Rehydrate just enough of a WeeklySignal from a persisted snapshot.

    ``concerns`` come back via ``_warnings_to_concerns`` from the snapshot's
    ``WarningDocument`` rows -- without them the cumulative prompt saw only
    one headline line per week and had nothing concrete to synthesize from.
    New snapshots preserve changes, concerns, and evidence limitations directly;
    warning reconstruction remains a compatibility fallback for older snapshots.
    """
    return WeeklySignal(
        status=snapshot.attention_status,
        confidence=snapshot.signal_confidence if snapshot.signal_confidence is not None else 0.5,
        headline=snapshot.signal_headline or "(no headline)",
        summary=snapshot.signal_summary or "",
        work_volume=snapshot.signal_work_volume or "none",
        what_changed=list(snapshot.signal_changes),
        concerns=list(snapshot.signal_concerns or concerns or []),
        data_gaps=list(snapshot.signal_data_gaps),
    )


async def generate_cumulative_checkpoint(
    project_id: str,
    as_of_date: date,
    *,
    settings: Settings | None = None,
    database: Any = None,
    weekly_judge: WeeklySignalJudge | None = None,
    cumulative_judge: CumulativeCheckpointJudge | None = None,
) -> CumulativeCheckpointDocument | None:
    """Compute, or return the already-cached, cumulative-progress checkpoint.

    Bounded, two-layer evidence (see ``backend.cumulative_llm`` module
    docstring): a small "deep tail" of full diff-judged recent weeks
    (reusing ``generate_llm_snapshot`` unchanged, cached forever per week)
    plus, only when there's no recent-enough prior checkpoint to build on,
    one cheap commit-count sweep over older history. Cost per call is
    bounded and independent of how much project history exists.

    ``None`` means nothing could be computed (no project, or the
    synthesis failed) -- callers must not treat that as a cacheable
    "insufficient data" result; a retry can still succeed.
    """
    settings = settings or get_settings()
    database = database or get_active_repository()
    now = _utc_now()
    today = now.date()
    if as_of_date > today:
        raise ValueError("as_of_date must not be in the future")
    as_of_week_start = _iso_week_start(as_of_date)
    current_week_start = _iso_week_start(today)
    is_provisional = as_of_date == today

    lock = await _cumulative_lock((id(database), project_id, as_of_date))
    async with lock:
        all_checkpoints = await database.list("cumulative_checkpoints")
        project_checkpoints = [
            c for c in all_checkpoints
            if str(c.project_id) == project_id and c.signal_version == CUMULATIVE_VERSION
        ]
        existing = next((c for c in project_checkpoints if c.as_of_date == as_of_date), None)
        if existing is not None and checkpoint_is_fresh(
            existing, as_of_date, now=now, ttl_minutes=settings.cumulative_provisional_ttl_minutes
        ):
            return existing

        project = await database.get_project(project_id)
        if project is None:
            return None

        boundary = await database.boundary_at(project_id, as_of_date)
        coverage_start = boundary.effective_from if boundary else as_of_date
        coverage_start = min(coverage_start, as_of_date)

        prior_doc = max(
            (c for c in project_checkpoints if c.as_of_week_start < as_of_week_start
             and c.as_of_date.weekday() == 6 and not c.is_provisional),
            key=lambda c: c.as_of_week_start,
            default=None,
        )
        gap_weeks = (as_of_week_start - prior_doc.as_of_week_start).days // 7 if prior_doc else None
        deep_tail_weeks = max(1, settings.cumulative_deep_tail_weeks)
        warm = prior_doc is not None and gap_weeks is not None and gap_weeks <= deep_tail_weeks

        rebuild_depth = max(1, settings.cumulative_chain_rebuild_depth)
        use_prior_context = warm and prior_doc is not None and prior_doc.chain_depth < rebuild_depth
        warm = warm and use_prior_context
        new_chain_depth = (prior_doc.chain_depth + 1) if use_prior_context else 0
        prior_context = _checkpoint_to_context(prior_doc) if use_prior_context else None

        if warm:
            deep_week_starts = [prior_doc.as_of_week_start + timedelta(weeks=i + 1) for i in range(gap_weeks)]
        else:
            deep_week_starts = [as_of_week_start - timedelta(weeks=i) for i in range(deep_tail_weeks)]
        deep_week_starts = sorted({w for w in deep_week_starts if _iso_week_start(coverage_start) <= w <= as_of_week_start})

        weekly_judge = weekly_judge if weekly_judge is not None else get_signal_judge(settings)
        semaphore = asyncio.Semaphore(3)

        async def _judge_week(week_start: date) -> WeeklySnapshotDocument | None:
            async with semaphore:
                persist = week_start + timedelta(days=6) <= as_of_date and week_start != current_week_start
                return await generate_llm_snapshot(
                    project_id, week_start, settings=settings, database=database,
                    judge=weekly_judge, persist=persist, through_date=as_of_date,
                )

        deep_snapshots = await asyncio.gather(*(_judge_week(week_start) for week_start in deep_week_starts))
        if any(snapshot is None for snapshot in deep_snapshots):
            return None

        # One pass over warnings, indexed by snapshot, so every deep week
        # below carries its own findings into the synthesis prompt.
        warnings_by_snapshot: dict[str, list[Any]] = defaultdict(list)
        for warning in await database.list("warnings"):
            if str(_field(warning, "project_id")) == project_id:
                warnings_by_snapshot[str(_field(warning, "snapshot_id"))].append(warning)

        def _signal_for(snapshot: WeeklySnapshotDocument) -> WeeklySignal:
            week_warnings = warnings_by_snapshot.get(str(snapshot.id), []) if snapshot.id is not None else []
            return _snapshot_to_weekly_signal(
                snapshot, _warnings_to_concerns(week_warnings, snapshot.week_start)
            )

        deep_signals: list[tuple[date, WeeklySignal]] = [
            (snapshot.week_start, _signal_for(snapshot))
            for snapshot in deep_snapshots
            if snapshot is not None
        ]
        source_snapshot_ids = [
            str(snapshot.id) for snapshot in deep_snapshots
            if snapshot is not None and snapshot.week_end == snapshot.week_start + timedelta(days=6)
            and snapshot.week_end < today and snapshot.id is not None
        ]

        shallow: HistoryMetadata | None = None
        history_truncated = False
        if not warm:
            deep_tail_start = min(deep_week_starts) if deep_week_starts else as_of_week_start
            shallow_end = deep_tail_start - timedelta(days=1)
            if coverage_start <= shallow_end:
                built = await build_code_evidence_reader(settings, database, project_id, at=as_of_date)
                if built is not None:
                    reader, repo_slugs = built
                    def read_history():
                        try:
                            return reader.history_metadata(repo_slugs, start=coverage_start, end=shallow_end)
                        finally:
                            closer = getattr(reader, "close", None)
                            if closer is not None:
                                closer()
                    try:
                        shallow = await anyio.to_thread.run_sync(read_history, abandon_on_cancel=True)
                    except Exception:
                        return None
                    if shallow.fetch_errors:
                        return None
                    history_truncated = shallow.truncated
                # Promote already-cached weekly rows inside the shallow span
                # to real deep signals -- free fidelity, never recomputed.
                deep_weeks_seen = {week_start for week_start, _ in deep_signals}
                all_snapshots = await database.list("snapshots")
                for snap in sorted(all_snapshots, key=lambda s: s.week_start, reverse=True):
                    if len(deep_signals) >= 52:
                        break
                    if (
                        str(snap.project_id) == project_id
                        and snap.rule_set_version == SIGNAL_VERSION
                        and coverage_start <= snap.week_start <= shallow_end
                        and snap.week_start not in deep_weeks_seen
                    ):
                        deep_signals.append((snap.week_start, _signal_for(snap)))
                        if snap.id is not None:
                            source_snapshot_ids.append(str(snap.id))
                        deep_weeks_seen.add(snap.week_start)
                if shallow:
                    shallow.weeks_counts = {w: count for w, count in shallow.weeks_counts.items() if w not in deep_weeks_seen}

        cumulative_judge = cumulative_judge if cumulative_judge is not None else get_cumulative_judge(settings)
        checkpoint = await judge_project_cumulative(
            project_name=project.display_name,
            lifecycle=project.lifecycle_state.value,
            as_of_date=as_of_date,
            coverage_start=coverage_start,
            deep_signals=deep_signals,
            shallow=shallow,
            judge=cumulative_judge,
            prior=prior_context,
        )
        if checkpoint.is_failure:
            return None

        # Not routed through _document(): its own first parameter is named
        # "model", which collides with CumulativeCheckpointDocument's model
        # field (the LLM model name).
        doc = CumulativeCheckpointDocument.model_construct(
            id=str(new_id()),
            project_id=project_id,
            as_of_date=as_of_date,
            as_of_week_start=as_of_week_start,
            coverage_start=coverage_start,
            signal_version=CUMULATIVE_VERSION,
            generated_at=now,
            model=checkpoint.model,
            status=checkpoint.status,
            confidence=checkpoint.confidence,
            trajectory=checkpoint.trajectory,
            headline=checkpoint.headline,
            narrative=checkpoint.narrative,
            work_to_date=checkpoint.work_to_date,
            milestones=checkpoint.milestones,
            open_concerns=checkpoint.open_concerns,
            recommendations=checkpoint.recommendations,
            data_gaps=checkpoint.data_gaps,
            weeks_deep_judged=sorted({week_start for week_start, _ in deep_signals}),
            weeks_shallow_counts={k.isoformat(): v for k, v in (shallow.weeks_counts if shallow else {}).items()},
            source_snapshot_ids=source_snapshot_ids,
            prior_checkpoint_id=str(prior_doc.id) if (use_prior_context and prior_doc and prior_doc.id) else None,
            chain_depth=new_chain_depth,
            history_truncated=history_truncated,
            is_provisional=is_provisional,
        )
        await database.add("cumulative_checkpoints", doc)
        return doc


class ScheduledJobHooks:
    """Register nightly and weekly callbacks with an injected scheduler."""

    def __init__(self, nightly: Callable[[], Any], weekly: Callable[[], Any]) -> None:
        self.nightly = nightly
        self.weekly = weekly

    def register(
        self,
        scheduler: Any,
        *,
        nightly_hour: int = 2,
        nightly_minute: int = 0,
        weekly_day: str = "mon",
        weekly_hour: int = 5,
        weekly_minute: int = 0,
    ) -> Any:
        scheduler.add_job(
            self.nightly,
            trigger="cron",
            id="phi-nightly-sync",
            day_of_week="*",
            hour=nightly_hour,
            minute=nightly_minute,
            max_instances=1,
            coalesce=True,
        )
        scheduler.add_job(
            self.weekly,
            trigger="cron",
            id="phi-weekly-snapshot",
            day_of_week=weekly_day,
            hour=weekly_hour,
            minute=weekly_minute,
            max_instances=1,
            coalesce=True,
        )
        return scheduler


def register_scheduled_jobs(
    scheduler: Any,
    *,
    nightly: Callable[[], Any],
    weekly: Callable[[], Any],
    nightly_hour: int = 2,
    nightly_minute: int = 0,
    weekly_day: str = "mon",
    weekly_hour: int = 5,
    weekly_minute: int = 0,
) -> Any:
    return ScheduledJobHooks(nightly, weekly).register(
        scheduler,
        nightly_hour=nightly_hour,
        nightly_minute=nightly_minute,
        weekly_day=weekly_day,
        weekly_hour=weekly_hour,
        weekly_minute=weekly_minute,
    )


# Stable hook names for scheduler wiring and older deployment manifests.
nightly_sync_job = run_nightly_sync
weekly_snapshot_job = run_weekly_snapshot_job
register_jobs = register_scheduled_jobs


__all__ = [
    "WEEKLY_SNAPSHOTS_COLLECTION",
    "run_nightly_sync",
    "run_weekly_backfill",
    "run_historical_backfill",
    "build_gitea_adapter",
    "build_gitea_adapters",
    "generate_weekly_snapshots",
    "run_weekly_snapshot_job",
    "nightly_sync_job",
    "weekly_snapshot_job",
    "ScheduledJobHooks",
    "register_scheduled_jobs",
    "register_jobs",
]
