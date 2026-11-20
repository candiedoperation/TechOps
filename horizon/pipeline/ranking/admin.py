"""T4.6 exec board tools: finalize a semester's ranking, compare runs, add notes.

    python -m pipeline.ranking.admin finalize --ranking-run-id ID --by PK [--replace]
    python -m pipeline.ranking.admin compare --base ID --candidate ID [--out DIR]
    python -m pipeline.ranking.admin add-note --ranking-run-id ID --member PK --project PK \
        --reviewer PK (--agrees | --disagrees) --comment TEXT [--suggested-change JSON]

The database URL comes from HORIZON_DATABASE_URL, as for the pipeline.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import sys
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

from . import score_store


class AdminError(RuntimeError):
    pass


def finalize(connection: psycopg.Connection, ranking_run_id: str, by: str, *, replace: bool = False) -> str | None:
    """Mark a published run final; returns the run it replaced, if any."""

    run = score_store.read_run(connection, ranking_run_id, lock=True)
    if run.status != "published":
        raise AdminError(f"Run {ranking_run_id} is {run.status}; only a published run can be final.")
    other = connection.execute(
        """
        SELECT ranking_run_id::text FROM horizon_ranking.ranking_runs
        WHERE season_type = %s AND season_year = %s AND is_final AND ranking_run_id <> %s
        FOR UPDATE
        """,
        (run.season_type, run.season_year, ranking_run_id),
    ).fetchone()
    if other and not replace:
        raise AdminError(f"Run {other[0]} is already final for {run.season_type} {run.season_year}; "
                         "pass --replace to replace it.")
    if other:
        connection.execute(
            """UPDATE horizon_ranking.ranking_runs SET is_final = false, finalized_by = NULL, finalized_at = NULL
               WHERE ranking_run_id = %s""",
            (other[0],),
        )
    connection.execute(
        """UPDATE horizon_ranking.ranking_runs SET is_final = true, finalized_by = %s, finalized_at = now()
           WHERE ranking_run_id = %s""",
        (by, ranking_run_id),
    )
    connection.execute(
        """
        INSERT INTO horizon_api.publications (domain, season_type, season_year, run_id, as_of, previous_run_id)
        VALUES ('ranking_final', %s, %s, %s, %s, %s)
        ON CONFLICT (domain, season_type, season_year) DO UPDATE SET
            run_id = EXCLUDED.run_id, as_of = EXCLUDED.as_of, published_at = now(),
            previous_run_id = EXCLUDED.previous_run_id
        """,
        (run.season_type, run.season_year, ranking_run_id, run.as_of, other[0] if other else None),
    )
    return other[0] if other else None


COMPARE_COLUMNS = ("authentik_user_pk", "display_name", "project_pk", "role", "comparison_group",
                   "base_status", "candidate_status", "base_score", "candidate_score", "score_change",
                   "base_rank", "candidate_rank", "rank_change")


def compare(connection: psycopg.Connection, base: str, candidate: str) -> list[dict]:
    """Score and rank changes per member between two runs (for example two rubric versions)."""

    rows = connection.execute(
        """
        SELECT coalesce(b.authentik_user_pk, c.authentik_user_pk), coalesce(b.display_name, c.display_name),
               coalesce(b.project_pk, c.project_pk), coalesce(b.role, c.role),
               coalesce(b.comparison_group, c.comparison_group),
               b.status, c.status, b.overall_score, c.overall_score, b.rank_in_group, c.rank_in_group
        FROM (SELECT m.*, s.status, s.overall_score, s.rank_in_group FROM horizon_ranking.ranked_members m
              JOIN horizon_ranking.member_scores s USING (ranking_run_id, authentik_user_pk, project_pk)
              WHERE m.ranking_run_id = %s) b
        FULL JOIN (SELECT m.*, s.status, s.overall_score, s.rank_in_group FROM horizon_ranking.ranked_members m
                   JOIN horizon_ranking.member_scores s USING (ranking_run_id, authentik_user_pk, project_pk)
                   WHERE m.ranking_run_id = %s) c
          USING (authentik_user_pk, project_pk)
        ORDER BY 5, 1
        """,
        (base, candidate),
    ).fetchall()
    report = []
    for row in rows:
        entry = dict(zip(COMPARE_COLUMNS[:9], row[:9], strict=True))
        entry["score_change"] = (row[8] - row[7]) if row[7] is not None and row[8] is not None else None
        entry["base_rank"], entry["candidate_rank"] = row[9], row[10]
        entry["rank_change"] = (row[9] - row[10]) if row[9] is not None and row[10] is not None else None
        report.append({key: entry[key] for key in COMPARE_COLUMNS})
    return report


def report_csv(report: list[dict]) -> str:
    out = io.StringIO()
    writer = csv.DictWriter(out, fieldnames=COMPARE_COLUMNS, lineterminator="\n")
    writer.writeheader()
    writer.writerows(report)
    return out.getvalue()


def report_markdown(report: list[dict], base: str, candidate: str) -> str:
    def number(value):
        return "–" if value is None else f"{value:+.1f}" if isinstance(value, float) else str(value)

    moved = [row for row in report if row["rank_change"]]
    lines = ["# Ranking comparison", "", f"Base run `{base}`, candidate run `{candidate}`.", "",
             f"{len(report)} members; {len(moved)} changed rank; "
             f"{sum(row['base_status'] != row['candidate_status'] for row in report)} changed status.", "",
             "| Member | Group | Score (base → candidate) | Change | Rank (base → candidate) | Status |",
             "|---|---|---|---|---|---|"]
    for row in report:
        base_score = "–" if row["base_score"] is None else f"{row['base_score']:.1f}"
        cand_score = "–" if row["candidate_score"] is None else f"{row['candidate_score']:.1f}"
        status = row["candidate_status"] if row["base_status"] == row["candidate_status"] else \
            f"{row['base_status']} → {row['candidate_status']}"
        lines.append(f"| {row['display_name']} | {row['comparison_group']} | {base_score} → {cand_score} | "
                     f"{number(row['score_change'])} | {row['base_rank'] or '–'} → {row['candidate_rank'] or '–'} | {status} |")
    return "\n".join(lines) + "\n"


def add_note(connection: psycopg.Connection, *, ranking_run_id: str, member: str, project: str,
             reviewer: str, agrees: bool, comment: str, suggested_change: dict | None = None) -> str:
    exists = connection.execute(
        """SELECT 1 FROM horizon_ranking.ranked_members
           WHERE ranking_run_id = %s AND authentik_user_pk = %s AND project_pk = %s""",
        (ranking_run_id, member, project),
    ).fetchone()
    if not exists:
        raise AdminError(f"{member} on {project} is not ranked in run {ranking_run_id}.")
    if not comment.strip():
        raise AdminError("A calibration note needs a comment.")
    return connection.execute(
        """INSERT INTO horizon_ranking.calibration_notes
           (ranking_run_id, authentik_user_pk, project_pk, reviewer_pk, agrees, comment, suggested_change)
           VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING note_id::text""",
        (ranking_run_id, member, project, reviewer, agrees, comment.strip(),
         Jsonb(suggested_change) if suggested_change is not None else None),
    ).fetchone()[0]


def main(argv: list[str] | None = None, connect=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m pipeline.ranking.admin", description=__doc__.split("\n")[0])
    commands = parser.add_subparsers(dest="command", required=True)
    final = commands.add_parser("finalize", help="Mark a published run as the semester's final ranking.")
    final.add_argument("--ranking-run-id", required=True)
    final.add_argument("--by", required=True, help="Authentik pk of the exec board member.")
    final.add_argument("--replace", action="store_true", help="Replace the semester's current final run.")
    comp = commands.add_parser("compare", help="Write CSV and Markdown reports of score and rank changes.")
    comp.add_argument("--base", required=True)
    comp.add_argument("--candidate", required=True)
    comp.add_argument("--out", type=Path, default=Path("."))
    note = commands.add_parser("add-note", help="Record calibration feedback on one member's ranking.")
    note.add_argument("--ranking-run-id", required=True)
    note.add_argument("--member", required=True)
    note.add_argument("--project", required=True)
    note.add_argument("--reviewer", required=True)
    verdict = note.add_mutually_exclusive_group(required=True)
    verdict.add_argument("--agrees", action="store_true")
    verdict.add_argument("--disagrees", action="store_true")
    note.add_argument("--comment", required=True)
    note.add_argument("--suggested-change", type=json.loads)
    args = parser.parse_args(argv)

    if connect is None:
        from ..config import get_pipeline_settings

        url = get_pipeline_settings().require_database_url()
        connect = lambda: psycopg.connect(url)  # noqa: E731
    try:
        with connect() as connection:
            if args.command == "finalize":
                replaced = finalize(connection, args.ranking_run_id, args.by, replace=args.replace)
                print(f"Run {args.ranking_run_id} is final" + (f"; replaced {replaced}." if replaced else "."))
            elif args.command == "compare":
                report = compare(connection, args.base, args.candidate)
                args.out.mkdir(parents=True, exist_ok=True)
                stem = args.out / f"ranking-compare-{args.base[:8]}-{args.candidate[:8]}"
                stem.with_suffix(".csv").write_text(report_csv(report))
                stem.with_suffix(".md").write_text(report_markdown(report, args.base, args.candidate))
                print(f"Wrote {stem}.csv and {stem}.md ({len(report)} members).")
            else:
                note_id = add_note(connection, ranking_run_id=args.ranking_run_id, member=args.member,
                                   project=args.project, reviewer=args.reviewer, agrees=args.agrees,
                                   comment=args.comment, suggested_change=args.suggested_change)
                print(f"Added calibration note {note_id}.")
    except AdminError as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
