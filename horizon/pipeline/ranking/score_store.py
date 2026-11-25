"""Postgres reads and writes for T4.5 scoring and publishing."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime

import psycopg
from psycopg.types.json import Jsonb

from .members import RankedMember
from .metrics_code import MetricValue
from .read_models import StoredMetric, StoredScore
from .scoring import MemberScore

MemberKey = tuple[str, str]  # (authentik_user_pk, project_pk)


@dataclass(frozen=True)
class RunRow:
    ranking_run_id: str
    season_type: str
    season_year: int
    as_of: datetime
    rubric_version: str
    status: str
    is_final: bool


def read_run(connection: psycopg.Connection, ranking_run_id: str, *, lock: bool = False) -> RunRow:
    row = connection.execute(
        f"""
        SELECT ranking_run_id::text, season_type, season_year, as_of, rubric_version,
               status, is_final
        FROM horizon_ranking.ranking_runs WHERE ranking_run_id = %s
        {"FOR UPDATE" if lock else ""}
        """,
        (ranking_run_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Ranking run {ranking_run_id!r} does not exist.")
    return RunRow(*row)


def set_status(connection: psycopg.Connection, ranking_run_id: str, old: str, new: str) -> None:
    updated = connection.execute(
        """
        UPDATE horizon_ranking.ranking_runs
        SET status = %s, published_at = CASE WHEN %s = 'published' THEN now() ELSE published_at END
        WHERE ranking_run_id = %s AND status = %s
        """,
        (new, new, ranking_run_id, old),
    ).rowcount
    if updated != 1:
        raise RuntimeError(f"Ranking run {ranking_run_id!r} is not {old!r}; cannot mark it {new!r}.")


def read_unscored_metrics(
    connection: psycopg.Connection, ranking_run_id: str
) -> dict[MemberKey, dict[str, MetricValue]]:
    rows = connection.execute(
        """
        SELECT authentik_user_pk, project_pk, bucket_key, metric_key, raw_value,
               missing_reason, evidence
        FROM horizon_ranking.metric_values WHERE ranking_run_id = %s
        """,
        (ranking_run_id,),
    ).fetchall()
    result: dict[MemberKey, dict[str, MetricValue]] = defaultdict(dict)
    for user_pk, project_pk, bucket_key, metric_key, raw, reason, evidence in rows:
        result[(user_pk, project_pk)][metric_key] = MetricValue(
            user_pk, project_pk, bucket_key, metric_key, raw, reason, dict(evidence)
        )
    return result


def write_scores(
    connection: psycopg.Connection, ranking_run_id: str, scores: Mapping[MemberKey, MemberScore]
) -> int:
    """Store percentiles and member scores, replacing any earlier attempt of this run."""

    connection.execute(
        "DELETE FROM horizon_ranking.member_scores WHERE ranking_run_id = %s", (ranking_run_id,)
    )
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            UPDATE horizon_ranking.metric_values
            SET percentile = %s, group_size = %s, missing_reason = %s
            WHERE ranking_run_id = %s AND authentik_user_pk = %s AND project_pk = %s
              AND metric_key = %s
            """,
            [
                (metric.percentile, metric.group_size, metric.missing_reason,
                 ranking_run_id, user_pk, project_pk, metric_key)
                for (user_pk, project_pk), score in scores.items()
                for metric_key, metric in score.metrics.items()
            ],
        )
        cursor.executemany(
            """
            INSERT INTO horizon_ranking.member_scores (
                ranking_run_id, authentik_user_pk, project_pk, buckets, overall_score,
                coverage, status, rank_in_group, ranked_in_group
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    ranking_run_id, user_pk, project_pk,
                    Jsonb({key: {"score": bucket.score, "metricCoverage": bucket.metric_coverage}
                           for key, bucket in score.buckets.items()}),
                    score.overall_score, min(score.coverage, 1.0), score.status,
                    score.rank_in_group, score.ranked_in_group,
                )
                for (user_pk, project_pk), score in scores.items()
            ],
        )
    return len(scores)


def read_scores(connection: psycopg.Connection, ranking_run_id: str) -> dict[MemberKey, StoredScore]:
    rows = connection.execute(
        """
        SELECT authentik_user_pk, project_pk, buckets, overall_score, coverage, status,
               rank_in_group, ranked_in_group, explanation
        FROM horizon_ranking.member_scores WHERE ranking_run_id = %s
        """,
        (ranking_run_id,),
    ).fetchall()
    return {(row[0], row[1]): StoredScore(*row[2:]) for row in rows}


def read_scored_metrics(
    connection: psycopg.Connection, ranking_run_id: str
) -> dict[MemberKey, dict[str, StoredMetric]]:
    rows = connection.execute(
        """
        SELECT authentik_user_pk, project_pk, metric_key, raw_value, missing_reason,
               percentile, group_size, evidence
        FROM horizon_ranking.metric_values WHERE ranking_run_id = %s
        """,
        (ranking_run_id,),
    ).fetchall()
    result: dict[MemberKey, dict[str, StoredMetric]] = defaultdict(dict)
    for user_pk, project_pk, metric_key, *values in rows:
        result[(user_pk, project_pk)][metric_key] = StoredMetric(*values)
    return result


def score_problems(connection: psycopg.Connection, ranking_run_id: str) -> list[str]:
    """Integrity problems of a scored run; empty when every rule holds."""

    problems = []
    missing = connection.execute(
        """
        SELECT count(*) FROM horizon_ranking.ranked_members m
        LEFT JOIN horizon_ranking.member_scores s USING (ranking_run_id, authentik_user_pk, project_pk)
        WHERE m.ranking_run_id = %s AND s.ranking_run_id IS NULL
        """,
        (ranking_run_id,),
    ).fetchone()[0]
    if missing:
        problems.append(f"{missing} ranked member(s) have no member_scores row")
    bad_fields = connection.execute(
        """
        SELECT count(*) FROM horizon_ranking.member_scores
        WHERE ranking_run_id = %s AND (
            (status = 'ranked') <> (overall_score IS NOT NULL)
            OR (status = 'ranked') <> (rank_in_group IS NOT NULL AND ranked_in_group IS NOT NULL))
        """,
        (ranking_run_id,),
    ).fetchone()[0]
    if bad_fields:
        problems.append(f"{bad_fields} row(s) have a score or rank that does not match their status")
    bad_ranks = connection.execute(
        """
        WITH ranked AS (
            SELECT s.rank_in_group, s.ranked_in_group, s.overall_score, m.comparison_group
            FROM horizon_ranking.member_scores s
            JOIN horizon_ranking.ranked_members m USING (ranking_run_id, authentik_user_pk, project_pk)
            WHERE s.ranking_run_id = %s AND s.status = 'ranked')
        SELECT count(*) FROM ranked r
        WHERE r.rank_in_group <> 1 + (SELECT count(*) FROM ranked o WHERE o.comparison_group = r.comparison_group
                                       AND o.overall_score > r.overall_score + 1e-9)
           OR r.ranked_in_group <> (SELECT count(*) FROM ranked o WHERE o.comparison_group = r.comparison_group)
        """,
        (ranking_run_id,),
    ).fetchone()[0]
    if bad_ranks:
        problems.append(f"{bad_ranks} rank(s) are not standard competition ranks within their group")
    return problems


def group_members(members: list[RankedMember]) -> dict[str, list[RankedMember]]:
    """Members by comparison group, refusing a group scored with mixed weights."""

    groups: dict[str, list[RankedMember]] = defaultdict(list)
    for member in members:
        groups[member.comparison_group].append(member)
    for group, rows in groups.items():
        if len({(row.role, tuple(sorted(row.excluded_buckets))) for row in rows}) != 1:
            raise ValueError(f"comparison group {group!r} mixes roles or excluded buckets")
    return dict(groups)
