from datetime import timedelta

import pytest

from pipeline.ranking import admin

from ranking_db import AS_OF, needs_postgres
from test_ranking_publish_db import _publication, _publish, _scored, FakeContext

pytestmark = needs_postgres


def _published(postgres, dagster_run_id, days=0, scale=1.0):
    run = _scored(postgres, dagster_run_id, as_of=AS_OF + timedelta(days=days), scale=scale)
    _publish(FakeContext(), run, postgres)
    return run.ranking_run_id


def _final(postgres):
    with postgres.connect() as connection:
        runs = connection.execute(
            "SELECT ranking_run_id::text, finalized_by FROM horizon_ranking.ranking_runs WHERE is_final"
        ).fetchall()
        pointer = connection.execute(
            "SELECT run_id, previous_run_id FROM horizon_api.publications WHERE domain = 'ranking_final'"
        ).fetchone()
    return runs, pointer


def test_finalize_marks_the_run_and_publishes_ranking_final(ranking_postgres):
    run_id = _published(ranking_postgres, "dagster-a")
    assert admin.main(["finalize", "--ranking-run-id", run_id, "--by", "exec-1"],
                      connect=ranking_postgres.connect) == 0
    assert _final(ranking_postgres) == ([(run_id, "exec-1")], (run_id, None))
    assert _publication(ranking_postgres)[0] == run_id


def test_a_second_final_run_needs_replace(ranking_postgres, capsys):
    first = _published(ranking_postgres, "dagster-a")
    second = _published(ranking_postgres, "dagster-b", days=7)
    with ranking_postgres.connect() as connection:
        admin.finalize(connection, first, "exec-1")

    assert admin.main(["finalize", "--ranking-run-id", second, "--by", "exec-2"],
                      connect=ranking_postgres.connect) == 1
    assert "pass --replace" in capsys.readouterr().err
    assert _final(ranking_postgres)[0] == [(first, "exec-1")]

    with ranking_postgres.connect() as connection:
        assert admin.finalize(connection, second, "exec-2", replace=True) == first
    assert _final(ranking_postgres) == ([(second, "exec-2")], (second, first))


def test_only_a_published_run_can_be_final(ranking_postgres):
    run = _scored(ranking_postgres, "dagster-a")
    with ranking_postgres.connect() as connection, pytest.raises(admin.AdminError, match="only a published run"):
        admin.finalize(connection, run.ranking_run_id, "exec-1")


def test_compare_reports_score_and_rank_changes(ranking_postgres, tmp_path):
    base = _published(ranking_postgres, "dagster-a")
    candidate = _published(ranking_postgres, "dagster-b", days=7, scale=100.0)

    assert admin.main(["compare", "--base", base, "--candidate", candidate, "--out", str(tmp_path)],
                      connect=ranking_postgres.connect) == 0

    with ranking_postgres.connect() as connection:
        report = {row["authentik_user_pk"]: row for row in admin.compare(connection, base, candidate)}
    # D's code metrics were scaled past everyone else's, so D moves up and C drops to last.
    assert report["D"]["base_rank"] == 4 and report["D"]["candidate_rank"] < 4
    assert report["D"]["rank_change"] == 4 - report["D"]["candidate_rank"]
    assert report["D"]["score_change"] > 0 and report["A"]["score_change"] < 0
    csv_text = next(tmp_path.glob("*.csv")).read_text()
    markdown = next(tmp_path.glob("*.md")).read_text()
    assert csv_text.splitlines()[0] == ",".join(admin.COMPARE_COLUMNS) and len(csv_text.splitlines()) == 5
    assert "4 members" in markdown and "| Member D | project:proj-x:engineer |" in markdown


def test_add_note_records_calibration_feedback(ranking_postgres):
    run_id = _published(ranking_postgres, "dagster-a")
    assert admin.main(["add-note", "--ranking-run-id", run_id, "--member", "B", "--project", "proj-x",
                       "--reviewer", "exec-1", "--disagrees", "--comment", "Carried the review load.",
                       "--suggested-change", '{"rank_in_group": 1}'], connect=ranking_postgres.connect) == 0
    with ranking_postgres.connect() as connection:
        assert connection.execute(
            "SELECT agrees, comment, suggested_change FROM horizon_ranking.calibration_notes"
        ).fetchone() == (False, "Carried the review load.", {"rank_in_group": 1})
        with pytest.raises(admin.AdminError, match="not ranked"):
            admin.add_note(connection, ranking_run_id=run_id, member="Z", project="proj-x",
                           reviewer="exec-1", agrees=True, comment="?")
