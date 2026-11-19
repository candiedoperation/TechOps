import dataclasses
import re
from datetime import date, datetime, timezone

import pytest

from pipeline.ranking import store
from pipeline.ranking.metrics_code import (
    METRIC_KEYS as CODE_METRIC_KEYS,
    BlameCommitRow,
    CommitActivityRow,
    ContributionRow,
    GitCommitRow,
)
from pipeline.ranking.metrics_reviews import (
    METRIC_KEYS as REVIEW_METRIC_KEYS,
    PullRequestCommitRow,
    PullRequestRow,
    ReviewRequestRow,
    ReviewRow,
)
from pipeline.ranking.metrics_survey import METRIC_KEYS as RATING_METRIC_KEYS
from pipeline.ranking.metrics_survey import SurveyAnswerRow
from pipeline.ranking.rubric import load_rubric

REPOS = [("SpaceApp", "api")]
AS_OF = datetime(2026, 11, 8, tzinfo=timezone.utc)


class _Recorder:
    """Captures the statement a reader sends and returns no rows."""

    def __init__(self):
        self.statement = None

    def execute(self, statement, params=None):
        self.statement = statement
        return self

    def fetchall(self):
        return []


# Each reader builds its row dataclass positionally, so its SELECT list must
# name the dataclass's fields in order.
READERS = [
    (store.read_engineering_contribution, (["run"],), ContributionRow),
    (store.read_blame_commit_summary, (["run"],), BlameCommitRow),
    (store.read_member_commit_activity, (REPOS, AS_OF), CommitActivityRow),
    (store.read_git_commits, (REPOS, date(2026, 8, 31)), GitCommitRow),
    (store.read_pull_requests, (REPOS,), PullRequestRow),
    (store.read_pr_reviews, (REPOS,), ReviewRow),
    (store.read_pr_review_requests, (REPOS,), ReviewRequestRow),
    (store.read_pr_commits, (["run"],), PullRequestCommitRow),
    (store.read_survey_answers, ("FALL", 2026), SurveyAnswerRow),
]


@pytest.mark.parametrize(
    ("reader", "args", "row_type"), READERS, ids=[reader.__name__ for reader, _, _ in READERS]
)
def test_each_reader_selects_its_row_fields_in_order(reader, args, row_type):
    connection = _Recorder()

    assert reader(connection, *args) == []

    selected = re.search(r"SELECT\s+(.*?)\s+FROM", connection.statement, re.S).group(1)
    columns = [column.strip().split(".")[-1] for column in selected.split(",")]
    assert columns == [field.name for field in dataclasses.fields(row_type)]


def test_metric_steps_own_disjoint_rubric_keys():
    # replace_metric_values deletes only a step's own keys, so no two steps may
    # share one: otherwise re-running one step would delete the other's rows.
    code, reviews, ratings = set(CODE_METRIC_KEYS), set(REVIEW_METRIC_KEYS), set(RATING_METRIC_KEYS)
    rubric_keys = {
        metric.key
        for role in load_rubric("v1").rubric.roles.values()
        for bucket in role.buckets
        for metric in bucket.metrics
    }

    assert not code & reviews and not code & ratings and not reviews & ratings
    assert code | reviews | ratings <= rubric_keys
