"""Run the whole Track 4 graph against a seeded database and print what it produced.

    HORIZON_DATABASE_URL=postgresql://... python dev/t4-staging/run_t4.py [--compare-v1]

Materializes ranking_run through publish_ranking with their asset checks, in
one Dagster run (rubric v2, as_of from seed.py), then prints the leaderboard,
one member document and the check results, then checks the seeded cases
(exit code 1 if any is wrong). --compare-v1 also scores a v1 run (not
published) and writes the admin compare report next to this file.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from dagster import DagsterInstance, materialize

from pipeline.assets import (
    code_and_tenure_metrics, delivery_metrics, feature_store_schema, member_explanations,
    member_scores, member_scores_integrity, publish_ranking, publish_ranking_integrity,
    ranked_members, ranking_run, review_and_rating_metrics,
)
from pipeline.config import get_pipeline_settings
from pipeline.ranking import admin
from pipeline.storage import PostgresResource

sys.path.insert(0, str(Path(__file__).parent))
from seed import AS_OF, SEASON  # noqa: E402

THROUGH_SCORES = [feature_store_schema, ranking_run, ranked_members, code_and_tenure_metrics,
                  review_and_rating_metrics, delivery_metrics, member_scores, member_scores_integrity]
FULL = THROUGH_SCORES + [member_explanations, publish_ranking, publish_ranking_integrity]


def run(postgres: PostgresResource, rubric: str, assets) -> str:
    config = {"ops": {"ranking_run": {"config": {
        "season_type": SEASON[0], "season_year": SEASON[1], "as_of": AS_OF.isoformat(), "rubric_version": rubric,
    }}}}
    result = materialize(assets, resources={"postgres": postgres}, run_config=config,
                         instance=DagsterInstance.ephemeral(), raise_on_error=False)
    print(f"\n== Dagster run, rubric {rubric}: {'SUCCESS' if result.success else 'FAILED'}")
    for event in result.all_events:
        if event.event_type_value == "STEP_FAILURE":
            print(f"  step failed: {event.step_key}: {event.event_specific_data.error.message.strip()}")
        if event.event_type_value == "ASSET_CHECK_EVALUATION":
            check = event.event_specific_data
            print(f"  check {check.check_name}: {'passed' if check.passed else 'FAILED'} - {check.description}")
    with postgres.connect() as connection:
        run_id, status, reason = connection.execute(
            """SELECT ranking_run_id::text, status, failure_reason FROM horizon_ranking.ranking_runs
               WHERE rubric_version = %s ORDER BY created_at DESC LIMIT 1""", (rubric,)).fetchone()
    print(f"  ranking run {run_id}: {status}" + (f" ({reason})" if reason else ""))
    if not result.success:
        raise SystemExit(1)
    return run_id


def report(postgres: PostgresResource, run_id: str) -> None:
    with postgres.connect() as connection:
        rows = connection.execute(
            """SELECT comparison_group_label, rank_in_group, ranked_in_group, display_name, status,
                      round(overall_score::numeric, 1), round(coverage::numeric, 2)
               FROM horizon_api.ranking_leaderboard WHERE ranking_run_id = %s
               ORDER BY comparison_group_label, rank_in_group NULLS LAST, display_name""", (run_id,)).fetchall()
        document = connection.execute(
            """SELECT document FROM horizon_api.ranking_member_detail
               WHERE ranking_run_id = %s AND project_pk = 'p-beacon' ORDER BY authentik_user_pk LIMIT 1""",
            (run_id,)).fetchone()[0]
        pointer = connection.execute(
            "SELECT run_id FROM horizon_api.publications WHERE domain = 'ranking'").fetchone()[0]
    print(f"\n== Leaderboard (publication points at {'this run' if pointer == run_id else pointer})")
    group = None
    for label, rank, of, name, status, score, coverage in rows:
        if label != group:
            print(f"  {label}")
            group = label
        place = f"{rank}/{of}" if rank else "-"
        print(f"    {place:>5}  {name:<14} {status:<18} score {score if score is not None else '-':>5}  coverage {coverage}")
    print("\n== Member document (Beacon, review bucket switched off)")
    print("  buckets: " + ", ".join(f"{b['key']} {b['weight']:.2f}" for b in document["buckets"]))
    print("  explanation: " + json.dumps(document["explanation"])[:400])


def _expect(problems: list[str], ok: bool, what: str) -> None:
    print(f"  {'ok  ' if ok else 'FAIL'} {what}")
    if not ok:
        problems.append(what)


def verify(postgres: PostgresResource, run_id: str) -> list[str]:
    """Check each case the seed was built to show."""

    print("\n== Expected results")
    problems: list[str] = []
    with postgres.connect() as connection:
        def one(query, *params):
            return connection.execute(query, (run_id, *params)).fetchone()

        def reason(name, metric):
            row = one("""SELECT v.missing_reason FROM horizon_ranking.metric_values v
                         JOIN horizon_ranking.ranked_members m USING (ranking_run_id, authentik_user_pk, project_pk)
                         WHERE v.ranking_run_id = %s AND m.display_name = %s AND v.metric_key = %s""", name, metric)
            return row[0] if row else "<no row>"

        def status(name):
            row = one("""SELECT status FROM horizon_api.ranking_leaderboard
                         WHERE ranking_run_id = %s AND display_name = %s""", name)
            return row[0] if row else "<not ranked>"

        run = one("SELECT status FROM horizon_ranking.ranking_runs WHERE ranking_run_id = %s")[0]
        pointer = one("SELECT run_id = %s FROM horizon_api.publications WHERE domain = 'ranking'")
        _expect(problems, run == "published" and bool(pointer and pointer[0]),
                "the run is published and the ranking publication points at it")
        counts = one("""SELECT count(*) FILTER (WHERE role = 'engineer'), count(*) FILTER (WHERE role = 'tech_lead'),
                               count(*) FILTER (WHERE display_name = 'Rae Quist' OR project_pk = 'p-old')
                        FROM horizon_ranking.ranked_members WHERE ranking_run_id = %s""")
        _expect(problems, counts == (13, 4, 0), "13 engineers and 4 tech leads ranked; the PM and archived project are not")
        leads = one("""SELECT count(DISTINCT comparison_group) FROM horizon_ranking.ranked_members
                       WHERE ranking_run_id = %s AND role = 'tech_lead'""")[0]
        _expect(problems, leads == 1, "tech leads share one club-wide comparison group")
        _expect(problems, status("Jade Wu") == "group_too_small", "Comet's only engineer is group_too_small")
        _expect(problems, status("Milo Grant") == "insufficient_data"
                and reason("Milo Grant", "files_majority_owned") == "no_resolved_git_identity",
                "Milo Grant (no Git activity) is insufficient_data with no_resolved_git_identity")
        _expect(problems, reason("Kai Lee", "verified_completion") == "no_sow"
                and reason("Quinn Ash", "team_verified_completion") == "no_sow",
                "Dune (no SOW) has delivery NULL with reason no_sow")
        beacon = one("""SELECT count(*) FROM horizon_ranking.metric_values
                        WHERE ranking_run_id = %s AND project_pk = 'p-beacon' AND bucket_key = 'review_collaboration'""")[0]
        documents = connection.execute(
            """SELECT document FROM horizon_api.ranking_member_detail
               WHERE ranking_run_id = %s AND project_pk = 'p-beacon'""", (run_id,)).fetchall()
        weights_ok = documents and all(
            "review_collaboration" not in {b["key"] for b in d["buckets"]}
            and abs(sum(b["weight"] for b in d["buckets"]) - 1) < 1e-9 for (d,) in documents)
        _expect(problems, beacon == 0 and bool(weights_ok),
                "Beacon (reviews off) has no review rows and its bucket weights still sum to 1")
        unscored = one("""SELECT count(*) FROM horizon_ranking.member_scores
                          WHERE ranking_run_id = %s AND explanation IS NULL""")[0]
        _expect(problems, unscored == 0, "every member has an explanation (Claude or fallback)")
        surveys = one("""SELECT count(*) FROM horizon_ranking.metric_values
                         WHERE ranking_run_id = %s AND bucket_key IN ('peer_ratings', 'leadership_ratings')""")[0]
        _expect(problems, surveys == 0, "rubric v2 writes no survey metric rows")
    return problems + verify_values(postgres, run_id)


def verify_values(postgres: PostgresResource, run_id: str) -> list[str]:
    """Compare the run's metric values with the ones seed.py worked out itself."""

    with postgres.connect() as connection:
        rows = connection.execute(
            """SELECT e.metric_key, count(*), count(*) FILTER (WHERE v.raw_value IS NULL
                          OR abs(v.raw_value - e.value) > 1e-9),
                      min(m.display_name || ': got ' || coalesce(round(v.raw_value::numeric, 4)::text, 'NULL')
                          || ', expected ' || round(e.value::numeric, 4))
                        FILTER (WHERE v.raw_value IS NULL OR abs(v.raw_value - e.value) > 1e-9)
               FROM public.t4_expected e
               JOIN horizon_ranking.metric_values v ON v.ranking_run_id = %s
                    AND v.authentik_user_pk = e.authentik_user_pk AND v.project_pk = e.project_pk
                    AND v.metric_key = e.metric_key
               JOIN horizon_ranking.ranked_members m ON m.ranking_run_id = v.ranking_run_id
                    AND m.authentik_user_pk = v.authentik_user_pk AND m.project_pk = v.project_pk
               GROUP BY 1 ORDER BY 1""", (run_id,)).fetchall()
    problems = []
    for metric, compared, wrong, example in rows:
        _expect(problems, wrong == 0, f"{metric}: {compared - wrong}/{compared} values match seed.py"
                + (f" (e.g. {example})" if example else ""))
    return problems


def verify_values_only(postgres: PostgresResource, run_id: str, prefixes: tuple[str, ...]) -> list[str]:
    """verify_values, failing only on metrics with these prefixes (the rest were checked on v2)."""

    return [problem for problem in verify_values(postgres, run_id) if problem.startswith(prefixes)]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare-v1", action="store_true")
    args = parser.parse_args()
    postgres = PostgresResource(database_url=os.environ["HORIZON_DATABASE_URL"])
    settings = get_pipeline_settings()
    print("Explanations: " + (f"Claude ({settings.anthropic_model})" if settings.anthropic_api_key
                              else "no ANTHROPIC_API_KEY, deterministic fallbacks"))
    v2 = run(postgres, "v2", FULL)
    report(postgres, v2)
    problems = verify(postgres, v2)
    if args.compare_v1:
        v1 = run(postgres, "v1", THROUGH_SCORES)
        print("\n== Survey ratings in the v1 run (only the card's respondents count)")
        problems += verify_values_only(postgres, v1, ("eng_", "lead_"))
        out = Path(__file__).parent / "out"
        admin.main(["compare", "--base", v1, "--candidate", v2, "--out", str(out)])
    if problems:
        print(f"\n{len(problems)} expected result(s) did not hold.")
        raise SystemExit(1)
    print("\nAll expected results hold.")


if __name__ == "__main__":
    main()
