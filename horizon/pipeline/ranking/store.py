"""SQL for the ranking calculation layer.

Every helper takes an open psycopg connection, so the caller owns the
transaction. This is also the only module that names other tracks' tables:
T1.1's roster (``projects``, ``project_members``, ``project_repositories``),
T1.1's Gitea PR tables, T2.5's ``blame_commit_summary``, T2.6's
``git_commits`` and ``member_commit_activity``, T3.4's survey tables, and
T5.3/T5.4's SOW task tables. If their columns change, the change stays here.
"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import date, datetime

import psycopg
from psycopg.types.json import Jsonb

from .members import ProjectMemberRow, ProjectRow, RankedMember
from .metrics_code import (
    BlameCommitRow,
    CommitActivityRow,
    ContributionRow,
    GitCommitRow,
    MetricValue,
    Repository,
)
from .metrics_delivery import TaskMatchRow, TaskOverrideRow, TaskStatusRow
from .metrics_reviews import (
    PullRequestCommitRow,
    PullRequestRow,
    ReviewRequestRow,
    ReviewRow,
)
from .metrics_survey import SurveyAnswerRow
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
               m.roles, m.role_titles, m.tenure_semesters, m.role_mapping_version,
               m.email
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
            email=row[8],
        )
        for row in rows
    ]


def read_team_settings(
    connection: psycopg.Connection, project_pks: Sequence[str]
) -> dict[str, dict[str, bool]]:
    """Per-project rubric switches; a project with no row keeps every bucket on."""

    rows = connection.execute(
        """
        SELECT project_pk, engineers_review_prs
        FROM horizon_ranking.project_review_settings
        WHERE project_pk = ANY(%s)
        """,
        (list(project_pks),),
    ).fetchall()
    return {row[0]: {"engineers_review_prs": row[1]} for row in rows}


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


def _lock_running_run(
    connection: psycopg.Connection, ranking_run_id: str, action: str
) -> None:
    """Lock the run row; writing is only allowed while the run is running."""

    status = connection.execute(
        """
        SELECT status FROM horizon_ranking.ranking_runs
        WHERE ranking_run_id = %s FOR UPDATE
        """,
        (ranking_run_id,),
    ).fetchone()
    if status is None or status[0] != "running":
        raise RuntimeError(
            f"Cannot {action} for ranking run {ranking_run_id!r}: "
            "the run is missing or no longer running."
        )


def replace_ranked_members(
    connection: psycopg.Connection,
    ranking_run_id: str,
    members: Sequence[RankedMember],
) -> int:
    """Replace a running run's member snapshot, including with an empty one."""

    _lock_running_run(connection, ranking_run_id, "snapshot members")
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
                window_start, window_end, excluded_buckets
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::text[])
            """,
            [
                (
                    ranking_run_id, member.authentik_user_pk, member.project_pk,
                    member.role, member.display_name, member.role_title,
                    member.project_name, member.comparison_group,
                    member.tenure_semesters, member.window_start, member.window_end,
                    list(member.excluded_buckets),
                )
                for member in members
            ],
        )
    return len(members)


def read_source_runs(connection: psycopg.Connection, ranking_run_id: str) -> dict[str, str]:
    row = connection.execute(
        "SELECT source_runs FROM horizon_ranking.ranking_runs WHERE ranking_run_id = %s",
        (ranking_run_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Ranking run {ranking_run_id!r} does not exist.")
    return dict(row[0])


def read_ranked_members(
    connection: psycopg.Connection, ranking_run_id: str
) -> list[RankedMember]:
    rows = connection.execute(
        """
        SELECT authentik_user_pk, project_pk, role, display_name, role_title,
               project_name, comparison_group, tenure_semesters, window_start,
               window_end, excluded_buckets
        FROM horizon_ranking.ranked_members
        WHERE ranking_run_id = %s
        ORDER BY project_pk, authentik_user_pk
        """,
        (ranking_run_id,),
    ).fetchall()
    return [RankedMember(*row[:10], excluded_buckets=tuple(row[10])) for row in rows]


def read_repositories_by_project(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> dict[str, list[Repository]]:
    """R(P) for every non-archived project of the season."""

    rows = connection.execute(
        """
        SELECT r.project_pk, r.organization, r.repository
        FROM horizon_gt_features.project_repositories AS r
        JOIN horizon_gt_features.projects AS p USING (project_pk)
        WHERE p.season_type = %s AND p.season_year = %s AND NOT p.archived
        ORDER BY r.project_pk, r.organization, r.repository
        """,
        (season_type, season_year),
    ).fetchall()
    repositories: dict[str, list[Repository]] = {}
    for project_pk, organization, repository in rows:
        repositories.setdefault(project_pk, []).append((organization, repository))
    return repositories


def read_engineering_contribution(
    connection: psycopg.Connection, run_ids: Sequence[str]
) -> list[ContributionRow]:
    rows = connection.execute(
        """
        SELECT run_id, organization, repository, authentik_user_pk,
               majority_owned_files, non_boundary_surviving_lines
        FROM horizon_gt_features.engineering_contribution
        WHERE run_id = ANY(%s) AND authentik_user_pk IS NOT NULL
        """,
        (list(run_ids),),
    ).fetchall()
    return [ContributionRow(*row) for row in rows]


def read_blame_commit_summary(
    connection: psycopg.Connection, run_ids: Sequence[str]
) -> list[BlameCommitRow]:
    """Eligible, resolved summary rows of the given runs (never blame_records)."""

    rows = connection.execute(
        """
        SELECT run_id, organization, repository, blamed_file_path, commit_sha,
               authentik_user_pk, eligible, line_count
        FROM horizon_gt_features.blame_commit_summary
        WHERE run_id = ANY(%s) AND eligible AND authentik_user_pk IS NOT NULL
        """,
        (list(run_ids),),
    ).fetchall()
    return [BlameCommitRow(*row) for row in rows]


def read_member_commit_activity(
    connection: psycopg.Connection, repositories: Sequence[Repository], as_of: datetime
) -> list[CommitActivityRow]:
    """Latest-state activity, so it is filtered by date rather than run id."""

    rows = connection.execute(
        """
        SELECT a.organization, a.repository, a.commit_sha, a.authentik_user_pk,
               a.credit, a.activity_at, a.source, a.eligible_lines_changed
        FROM horizon_gt_features.member_commit_activity AS a
        JOIN unnest(%s::text[], %s::text[]) AS r(organization, repository)
            USING (organization, repository)
        WHERE a.activity_at <= %s
        """,
        (*_split_repositories(repositories), as_of),
    ).fetchall()
    return [CommitActivityRow(*row) for row in rows]


def read_git_commits(
    connection: psycopg.Connection,
    repositories: Sequence[Repository],
    authored_from: date,
) -> list[GitCommitRow]:
    """Default-branch commits with a resolved author, from ``authored_from`` on."""

    rows = connection.execute(
        """
        SELECT g.organization, g.repository, g.commit_sha, g.authentik_user_pk,
               g.authored_at, g.eligible_lines_added, g.on_default_branch
        FROM horizon_gt_features.git_commits AS g
        JOIN unnest(%s::text[], %s::text[]) AS r(organization, repository)
            USING (organization, repository)
        WHERE g.on_default_branch AND g.authentik_user_pk IS NOT NULL
          AND g.authored_at >= %s::date - interval '1 day'
        """,
        (*_split_repositories(repositories), authored_from),
    ).fetchall()
    return [GitCommitRow(*row) for row in rows]


def _split_repositories(repositories: Sequence[Repository]) -> tuple[list[str], list[str]]:
    return [org for org, _ in repositories], [repo for _, repo in repositories]


def replace_metric_values(
    connection: psycopg.Connection,
    ranking_run_id: str,
    metric_keys: Sequence[str],
    values: Sequence[MetricValue],
) -> int:
    """Replace this step's metric rows for a running run.

    Only ``metric_keys`` are deleted, so other Track 4 steps writing the same
    run keep their rows.
    """

    stray = sorted({value.metric_key for value in values} - set(metric_keys))
    if stray:
        raise ValueError(f"metric keys outside this step: {stray}")
    _lock_running_run(connection, ranking_run_id, "write metric values")
    connection.execute(
        """
        DELETE FROM horizon_ranking.metric_values
        WHERE ranking_run_id = %s AND metric_key = ANY(%s)
        """,
        (ranking_run_id, list(metric_keys)),
    )
    with connection.cursor() as cursor:
        cursor.executemany(
            """
            INSERT INTO horizon_ranking.metric_values (
                ranking_run_id, authentik_user_pk, project_pk, bucket_key,
                metric_key, raw_value, missing_reason, evidence
            ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    ranking_run_id, value.authentik_user_pk, value.project_pk,
                    value.bucket_key, value.metric_key, value.raw_value,
                    value.missing_reason, Jsonb(value.evidence),
                )
                for value in values
            ],
        )
    return len(values)


def read_pull_requests(
    connection: psycopg.Connection, repositories: Sequence[Repository]
) -> list[PullRequestRow]:
    rows = connection.execute(
        """
        SELECT p.organization, p.repository, p.number, p.author_login, p.author_pk,
               p.merged, p.created_at, p.merged_at
        FROM horizon_gt_features.gitea_pull_requests AS p
        JOIN unnest(%s::text[], %s::text[]) AS r(organization, repository)
            USING (organization, repository)
        """,
        _split_repositories(repositories),
    ).fetchall()
    return [PullRequestRow(*row) for row in rows]


def read_pr_reviews(
    connection: psycopg.Connection, repositories: Sequence[Repository]
) -> list[ReviewRow]:
    rows = connection.execute(
        """
        SELECT v.organization, v.repository, v.pr_number, v.review_id,
               v.reviewer_login, v.reviewer_pk, v.state, v.submitted_at
        FROM horizon_gt_features.gitea_pr_reviews AS v
        JOIN unnest(%s::text[], %s::text[]) AS r(organization, repository)
            USING (organization, repository)
        """,
        _split_repositories(repositories),
    ).fetchall()
    return [ReviewRow(*row) for row in rows]


def read_pr_review_requests(
    connection: psycopg.Connection, repositories: Sequence[Repository]
) -> list[ReviewRequestRow]:
    rows = connection.execute(
        """
        SELECT q.organization, q.repository, q.pr_number, q.event_id,
               q.requested_login, q.requested_pk, q.requested_at
        FROM horizon_gt_features.gitea_pr_review_requests AS q
        JOIN unnest(%s::text[], %s::text[]) AS r(organization, repository)
            USING (organization, repository)
        """,
        _split_repositories(repositories),
    ).fetchall()
    return [ReviewRequestRow(*row) for row in rows]


def read_pr_commits(
    connection: psycopg.Connection, run_ids: Sequence[str]
) -> list[PullRequestCommitRow]:
    rows = connection.execute(
        """
        SELECT organization, repository, pull_request_number, commit_sha,
               authentik_user_pk, dagster_run_id, message
        FROM horizon_gt_features.pr_linked_commit_messages
        WHERE dagster_run_id = ANY(%s)
        """,
        (list(run_ids),),
    ).fetchall()
    return [PullRequestCommitRow(*row) for row in rows]


def read_survey_answers(
    connection: psycopg.Connection, season_type: str, season_year: int
) -> list[SurveyAnswerRow]:
    """Every answer in the season's survey rounds; as_of is applied by the caller."""

    rows = connection.execute(
        """
        SELECT a.response_id, a.question_key, a.round_id, a.project_pk,
               a.respondent_pk, a.respondent_role, a.ratee_pk, a.ratee_role,
               a.value, a.submitted_at
        FROM horizon_gt_features.survey_answers AS a
        JOIN horizon_gt_features.survey_rounds AS r USING (round_id)
        WHERE r.season_type = %s AND r.season_year = %s
        """,
        (season_type, season_year),
    ).fetchall()
    return [SurveyAnswerRow(*row) for row in rows]


def read_project_run_id(connection: psycopg.Connection, ranking_run_id: str) -> str | None:
    row = connection.execute(
        "SELECT project_run_id FROM horizon_ranking.ranking_runs WHERE ranking_run_id = %s",
        (ranking_run_id,),
    ).fetchone()
    if row is None:
        raise RuntimeError(f"Ranking run {ranking_run_id!r} does not exist.")
    return row[0]


def read_sow_task_status(
    connection: psycopg.Connection, project_run_id: str, project_pks: Sequence[str]
) -> list[TaskStatusRow]:
    """The project run's task status, joined to the tasks of the breakdown it used."""

    rows = connection.execute(
        """
        SELECT s.task_id::text AS task_id, t.project_pk, t.task_key, t.due_date,
               s.completion, s.completion_value, s.owner_pks
        FROM horizon_projects.sow_task_status AS s
        JOIN horizon_projects.sow_tasks AS t USING (task_id)
        WHERE s.run_id = %s AND t.project_pk = ANY(%s::text[])
        """,
        (project_run_id, list(project_pks)),
    ).fetchall()
    return [TaskStatusRow(*row) for row in rows]


def read_sow_task_overrides(
    connection: psycopg.Connection, project_run_id: str
) -> list[TaskOverrideRow]:
    """Every override of the run's tasks; as_of is applied by the caller."""

    rows = connection.execute(
        """
        SELECT o.override_id::text AS override_id, o.task_id::text AS task_id,
               o.completion, o.owner_pks, o.set_at
        FROM horizon_projects.sow_task_overrides AS o
        JOIN horizon_projects.sow_task_status AS s USING (task_id)
        WHERE s.run_id = %s
        """,
        (project_run_id,),
    ).fetchall()
    return [TaskOverrideRow(*row) for row in rows]


def read_sow_task_matches(
    connection: psycopg.Connection, project_run_id: str
) -> list[TaskMatchRow]:
    rows = connection.execute(
        """
        SELECT m.task_id::text AS task_id, m.organization, m.repository, m.pr_number
        FROM horizon_projects.sow_task_matches AS m
        WHERE m.run_id = %s
        """,
        (project_run_id,),
    ).fetchall()
    return [TaskMatchRow(*row) for row in rows]
