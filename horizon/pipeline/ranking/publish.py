"""T4.5 publishing: write a scored run's read models and move the publication.

Everything happens in the caller's single transaction, so the website sees
either the previous run or the complete new one, never a mix.
"""

from __future__ import annotations

from collections import defaultdict

import psycopg
from psycopg.types.json import Jsonb

from . import score_store, store
from .read_models import LEADERBOARD_COLUMNS, RankingDocument, build_document, leaderboard_row
from .rubric import Rubric

BATCH = 500


class PublishError(RuntimeError):
    """The run cannot be published; the previous publication stays in place."""


def current_publication(connection: psycopg.Connection, season_type: str, season_year: int):
    return connection.execute(
        """
        SELECT run_id, as_of FROM horizon_api.publications
        WHERE domain = 'ranking' AND season_type = %s AND season_year = %s
        FOR UPDATE
        """,
        (season_type, season_year),
    ).fetchone()


def _history(connection: psycopg.Connection, run: score_store.RunRow) -> dict:
    """Earlier published runs of the semester per member, oldest first."""

    rows = connection.execute(
        """
        SELECT s.authentik_user_pk, s.project_pk, r.ranking_run_id::text, r.as_of, s.status,
               s.overall_score, s.rank_in_group
        FROM horizon_ranking.member_scores s
        JOIN horizon_ranking.ranking_runs r USING (ranking_run_id)
        WHERE r.status = 'published' AND r.season_type = %s AND r.season_year = %s
          AND r.ranking_run_id <> %s AND r.as_of < %s
        ORDER BY r.as_of, r.ranking_run_id
        """,
        (run.season_type, run.season_year, run.ranking_run_id, run.as_of),
    ).fetchall()
    history = defaultdict(list)
    for user_pk, project_pk, run_id, as_of, status, score, rank in rows:
        history[(user_pk, project_pk)].append({
            "rankingRunId": run_id, "asOf": as_of.isoformat(), "status": status,
            "overallScore": score, "rankInGroup": rank,
        })
    return history


def publish_run(connection: psycopg.Connection, run: score_store.RunRow, rubric: Rubric) -> int:
    """Write the read models for a locked, scored run and point the website at it."""

    if run.status != "scored":
        raise PublishError(f"Ranking run {run.ranking_run_id} is {run.status}; only a scored run is published.")
    current = current_publication(connection, run.season_type, run.season_year)
    if current is not None and current[0] != run.ranking_run_id and current[1] > run.as_of:
        raise PublishError(f"A newer run ({current[0]}) is already published for this semester.")

    members = store.read_ranked_members(connection, run.ranking_run_id)
    scores = score_store.read_scores(connection, run.ranking_run_id)
    metrics = score_store.read_scored_metrics(connection, run.ranking_run_id)
    history = _history(connection, run)
    leaders, documents = [], []
    for member in members:
        key = (member.authentik_user_pk, member.project_pk)
        if key not in scores:
            raise PublishError(f"Member {key} has no score row.")
        score = scores[key]
        entry = {"rankingRunId": run.ranking_run_id, "asOf": run.as_of.isoformat(), "status": score.status,
                 "overallScore": score.overall_score, "rankInGroup": score.rank_in_group}
        document = build_document(
            ranking_run_id=run.ranking_run_id, as_of=run.as_of, rubric_version=run.rubric_version,
            member=member, role_rubric=rubric.roles[member.role], score=score,
            metrics=metrics[key], history=[*history.get(key, []), entry],
        )
        row = leaderboard_row(ranking_run_id=run.ranking_run_id, season_type=run.season_type,
                              season_year=run.season_year, as_of=run.as_of, member=member, score=score)
        leaders.append((*row[:-1], Jsonb(row[-1])))
        documents.append((run.ranking_run_id, *key, Jsonb(document)))

    for table in ("ranking_leaderboard", "ranking_member_detail"):
        connection.execute(f"DELETE FROM horizon_api.{table} WHERE ranking_run_id = %s", (run.ranking_run_id,))
    placeholders = ", ".join(["%s"] * len(LEADERBOARD_COLUMNS))
    with connection.cursor() as cursor:
        for start in range(0, len(leaders), BATCH):
            cursor.executemany(
                f"INSERT INTO horizon_api.ranking_leaderboard ({', '.join(LEADERBOARD_COLUMNS)}) "
                f"VALUES ({placeholders})",
                leaders[start:start + BATCH],
            )
            cursor.executemany(
                """INSERT INTO horizon_api.ranking_member_detail
                   (ranking_run_id, authentik_user_pk, project_pk, document) VALUES (%s, %s, %s, %s)""",
                documents[start:start + BATCH],
            )
    connection.execute(
        """
        INSERT INTO horizon_api.publications (domain, season_type, season_year, run_id, as_of, previous_run_id)
        VALUES ('ranking', %s, %s, %s, %s, NULL)
        ON CONFLICT (domain, season_type, season_year) DO UPDATE SET
            run_id = EXCLUDED.run_id, as_of = EXCLUDED.as_of, published_at = now(),
            previous_run_id = CASE WHEN horizon_api.publications.run_id = EXCLUDED.run_id
                                   THEN horizon_api.publications.previous_run_id
                                   ELSE horizon_api.publications.run_id END
        """,
        (run.season_type, run.season_year, run.ranking_run_id, run.as_of),
    )
    score_store.set_status(connection, run.ranking_run_id, "scored", "published")
    return len(leaders)


def publish_problems(connection: psycopg.Connection, run: score_store.RunRow) -> list[str]:
    """What is wrong with a published run's serving rows; empty when it is sound."""

    problems = []
    current = connection.execute(
        "SELECT run_id FROM horizon_api.publications WHERE domain = 'ranking' AND season_type = %s AND season_year = %s",
        (run.season_type, run.season_year),
    ).fetchone()
    if current is None or current[0] != run.ranking_run_id:
        problems.append("the ranking publication does not point at this run")
    expected = {(m.authentik_user_pk, m.project_pk) for m in store.read_ranked_members(connection, run.ranking_run_id)}
    leaders = connection.execute(
        "SELECT authentik_user_pk, project_pk FROM horizon_api.ranking_leaderboard WHERE ranking_run_id = %s",
        (run.ranking_run_id,),
    ).fetchall()
    if set(leaders) != expected or len(leaders) != len(expected):
        problems.append("leaderboard rows do not match the ranked members")
    documents = connection.execute(
        "SELECT authentik_user_pk, project_pk, document FROM horizon_api.ranking_member_detail WHERE ranking_run_id = %s",
        (run.ranking_run_id,),
    ).fetchall()
    if {(user, project) for user, project, _ in documents} != expected:
        problems.append("member documents do not match the ranked members")
    for user, project, document in documents:
        try:
            RankingDocument.model_validate(document)
        except ValueError:
            problems.append(f"document for {user}/{project} does not match RankingDocument")
    return problems + score_store.score_problems(connection, run.ranking_run_id)
