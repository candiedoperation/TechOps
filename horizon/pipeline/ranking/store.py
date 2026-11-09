"""SQL for the ranking calculation layer.

Every helper takes an open psycopg connection, so the caller owns the
transaction. This is also the only module that names T1.1's roster tables
(``projects``, ``project_members``, ``project_repositories``); if their columns
change, the change stays here.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime

import psycopg
from psycopg.types.json import Jsonb

from .members import ProjectMemberRow, ProjectRow, RankedMember
from .rubric import LoadedRubric
from .sources import CompleteRun


class RubricChangedError(RuntimeError):
    """A stored rubric version no longer matches its file."""


def upsert_rubric(connection: psycopg.Connection, loaded: LoadedRubric) -> None:
    """Store a rubric version once; refuse a file that changed under the same version.

    A version is immutable after its first run, because every stored score
    points at it. Matching content is a no-op, never an overwrite.
    """

    connection.execute(
        """
        INSERT INTO horizon_ranking.rubric_versions
            (rubric_version, definition, definition_sha256)
        VALUES (%s, %s, %s)
        ON CONFLICT (rubric_version) DO NOTHING
        """,
        (loaded.version, Jsonb(loaded.definition), loaded.sha256),
    )
    stored = connection.execute(
        """
        SELECT definition_sha256 FROM horizon_ranking.rubric_versions
        WHERE rubric_version = %s
        """,
        (loaded.version,),
    ).fetchone()
    if stored is None or stored[0] != loaded.sha256:
        raise RubricChangedError(
            f"rubric {loaded.version} changed; create a new version instead"
        )


def read_season_projects(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> list[ProjectRow]:
    rows = connection.execute(
        """
        SELECT project_pk, season_type, season_year, name, friendly_name,
               window_start, window_end, archived
        FROM horizon_gt_features.projects
        WHERE season_type = %s AND season_year = %s
        """,
        (season_type, season_year),
    ).fetchall()
    return [ProjectRow(*row) for row in rows]


def read_season_members(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> list[ProjectMemberRow]:
    rows = connection.execute(
        """
        SELECT m.project_pk, m.authentik_user_pk, m.username, m.display_name,
               m.roles, m.role_titles, m.tenure_semesters, m.role_mapping_version
        FROM horizon_gt_features.project_members AS m
        JOIN horizon_gt_features.projects AS p USING (project_pk)
        WHERE p.season_type = %s AND p.season_year = %s
        """,
        (season_type, season_year),
    ).fetchall()
    return [
        ProjectMemberRow(
            project_pk=row[0],
            authentik_user_pk=row[1],
            username=row[2],
            display_name=row[3],
            roles=tuple(row[4]),
            role_titles=dict(row[5]),
            tenure_semesters=row[6],
            role_mapping_version=row[7],
        )
        for row in rows
    ]


def read_project_repositories(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> list[tuple[str, str]]:
    """The (organization, repository) pairs of the season's non-archived projects."""

    rows = connection.execute(
        """
        SELECT r.organization, r.repository
        FROM horizon_gt_features.project_repositories AS r
        JOIN horizon_gt_features.projects AS p USING (project_pk)
        WHERE p.season_type = %s AND p.season_year = %s AND NOT p.archived
        ORDER BY r.organization, r.repository
        """,
        (season_type, season_year),
    ).fetchall()
    return [(row[0], row[1]) for row in rows]


def latest_complete_runs(
    connection: psycopg.Connection, as_of: datetime
) -> dict[tuple[str, str], CompleteRun]:
    """Each repository's most recent complete feature run at or before ``as_of``."""

    rows = connection.execute(
        """
        SELECT DISTINCT ON (organization, repository)
               organization, repository, run_id, completed_at
        FROM horizon_gt_features.pipeline_runs
        WHERE status = 'complete' AND completed_at <= %s
        ORDER BY organization, repository, completed_at DESC
        """,
        (as_of,),
    ).fetchall()
    return {(row[0], row[1]): CompleteRun(row[2], row[3]) for row in rows}


def published_project_run(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> str | None:
    row = connection.execute(
        """
        SELECT run_id FROM horizon_api.publications
        WHERE domain = 'projects' AND season_type = %s AND season_year = %s
        """,
        (season_type, season_year),
    ).fetchone()
    return row[0] if row else None


def start_ranking_run(
    connection: psycopg.Connection,
    *,
    dagster_run_id: str,
    season_type: str,
    season_year: int,
    as_of: datetime,
    rubric_version: str,
    role_mapping_version: str,
    project_run_id: str | None,
    source_runs: dict[str, str],
) -> str:
    """Open (or reopen, on a retry of the same Dagster run) a ranking run."""

    row = connection.execute(
        """
        INSERT INTO horizon_ranking.ranking_runs (
            dagster_run_id, season_type, season_year, as_of, rubric_version,
            role_mapping_version, project_run_id, source_runs, status
        ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, 'running')
        ON CONFLICT (dagster_run_id) DO UPDATE SET
            season_type = EXCLUDED.season_type,
            season_year = EXCLUDED.season_year,
            as_of = EXCLUDED.as_of,
            rubric_version = EXCLUDED.rubric_version,
            role_mapping_version = EXCLUDED.role_mapping_version,
            project_run_id = EXCLUDED.project_run_id,
            source_runs = EXCLUDED.source_runs,
            status = 'running',
            failure_reason = NULL
        RETURNING ranking_run_id::text
        """,
        (
            dagster_run_id, season_type, season_year, as_of, rubric_version,
            role_mapping_version, project_run_id, Jsonb(source_runs),
        ),
    ).fetchone()
    return row[0]


def fail_ranking_run(
    connection: psycopg.Connection, ranking_run_id: str, reason: str
) -> None:
    connection.execute(
        """
        UPDATE horizon_ranking.ranking_runs
        SET status = 'failed', failure_reason = %s
        WHERE ranking_run_id = %s
        """,
        (reason, ranking_run_id),
    )


def replace_ranked_members(
    connection: psycopg.Connection,
    ranking_run_id: str,
    members: Sequence[RankedMember],
) -> int:
    """Replace a running run's member snapshot, including with an empty one."""

    status = connection.execute(
        """
        SELECT status FROM horizon_ranking.ranking_runs
        WHERE ranking_run_id = %s FOR UPDATE
        """,
        (ranking_run_id,),
    ).fetchone()
    if status is None or status[0] != "running":
        raise RuntimeError(
            f"Cannot snapshot members for ranking run {ranking_run_id!r}: "
            "the run is missing or no longer running."
        )
    connection.execute(
        "DELETE FROM horizon_ranking.ranked_members WHERE ranking_run_id = %s",
        (ranking_run_id,),
    )
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO horizon_ranking.ranked_members (
                ranking_run_id, authentik_user_pk, project_pk, role, display_name,
                role_title, project_name, comparison_group, tenure_semesters,
                window_start, window_end
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    ranking_run_id, member.authentik_user_pk, member.project_pk,
                    member.role, member.display_name, member.role_title,
                    member.project_name, member.comparison_group,
                    member.tenure_semesters, member.window_start, member.window_end,
                )
                for member in members
            ],
        )
    return len(members)
