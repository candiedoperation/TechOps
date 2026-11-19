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
from pipeline.ranking.metrics_delivery import METRIC_KEYS as DELIVERY_METRIC_KEYS
from pipeline.ranking.metrics_delivery import TaskMatchRow, TaskOverrideRow, TaskStatusRow
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
    (store.read_sow_task_status, ("project-run", ["p1"]), TaskStatusRow),
    (store.read_sow_task_overrides, ("project-run",), TaskOverrideRow),
    (store.read_sow_task_matches, ("project-run",), TaskMatchRow),
]


@pytest.mark.parametrize(
    ("reader", "args", "row_type"), READERS, ids=[reader.__name__ for reader, _, _ in READERS]
)
def test_each_reader_selects_its_row_fields_in_order(reader, args, row_type):
    connection = _Recorder()

    assert reader(connection, *args) == []

    selected = re.search(r"SELECT\s+(.*?)\s+FROM", connection.statement, re.S).group(1)
    # The last word is the alias when there is one ("s.task_id::text AS task_id").
    columns = [column.split()[-1].split(".")[-1] for column in selected.split(",")]
    assert columns == [field.name for field in dataclasses.fields(row_type)]


def test_metric_steps_own_disjoint_rubric_keys_and_cover_the_rubric():
    # replace_metric_values deletes only a step's own keys, so no two steps may
    # share one: otherwise re-running one step would delete the other's rows.
    steps = [CODE_METRIC_KEYS, REVIEW_METRIC_KEYS, RATING_METRIC_KEYS, DELIVERY_METRIC_KEYS]
    rubric_keys = {
        metric.key
        for role in load_rubric("v1").rubric.roles.values()
        for bucket in role.buckets
        for metric in bucket.metrics
    }

    assert sum(len(set(keys)) for keys in steps) == len(set().union(*steps))
    assert set().union(*steps) == rubric_keys
