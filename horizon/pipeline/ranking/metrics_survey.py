"""Survey rating metrics (T4.3): round-then-semester means of 1-3 answers.

A rating metric's key is the survey question_key, and the member is the
ratee. Tech lead ratings need at least two respondents.
"""

from __future__ import annotations

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import datetime
from statistics import fmean

from .members import RankedMember
from .metrics_code import Measurement, MetricValue
from .metrics_reviews import rubric_rows
from .rubric import RoleRubric, Rubric

NO_RATINGS = "no_ratings"
TOO_FEW_RESPONDENTS = "too_few_respondents"
LEAD_MIN_RESPONDENTS = 2

ENGINEER_RATING_METRICS = ("eng_timeliness", "eng_proactiveness", "eng_design", "eng_collaboration")
LEAD_RATING_METRICS = ("lead_proactiveness", "lead_design", "lead_stakeholder", "lead_guidance")
METRIC_KEYS = (*ENGINEER_RATING_METRICS, *LEAD_RATING_METRICS)

RatingKey = tuple[str, str, str]  # (project_pk, ratee_pk, question_key)

# Who rates what (T4.3, from T3.2's assignments): an engineer's ratings come
# from their tech lead; a tech lead is rated by engineers and the project lead,
# and lead_guidance by engineers only. Roles are T3.1's normalized names.
RESPONDENT_ROLES = {
    **{key: frozenset({"tech_lead"}) for key in ENGINEER_RATING_METRICS},
    **{key: frozenset({"engineer", "project_lead"}) for key in LEAD_RATING_METRICS},
    "lead_guidance": frozenset({"engineer"}),
}


def counts_respondent(answer: SurveyAnswerRow) -> bool:
    """Whether the answer's respondent is one T4.3 counts for its question.

    An answer with no respondent role is not counted. Questions outside the
    rubric are not filtered.
    """

    allowed = RESPONDENT_ROLES.get(answer.question_key)
    return allowed is None or answer.respondent_role in allowed


@dataclass(frozen=True)
class SurveyAnswerRow:
    """The columns of ``horizon_gt_features.survey_answers`` (T3.4)."""

    response_id: str
    question_key: str
    round_id: str
    project_pk: str
    respondent_pk: str
    respondent_role: str | None
    ratee_pk: str
    ratee_role: str | None
    value: int | None  # 1 to 3; NULL is N/A
    submitted_at: datetime | None


@dataclass(frozen=True)
class RatingMean:
    project_pk: str
    ratee_pk: str
    question_key: str
    mean: float
    respondent_count: int
    rounds_counted: int


def round_means(answers: Iterable[SurveyAnswerRow]) -> dict[RatingKey, dict[str, float]]:
    """Per rating key, the mean of the non-null answers in each round that has one."""

    values: dict[RatingKey, dict[str, list[int]]] = {}
    for answer in answers:
        if answer.value is None:
            continue
        key = (answer.project_pk, answer.ratee_pk, answer.question_key)
        values.setdefault(key, {}).setdefault(answer.round_id, []).append(answer.value)
    return {
        key: {round_id: fmean(rows) for round_id, rows in sorted(rounds.items())}
        for key, rounds in values.items()
    }


def _semester_rating_means(answers: Sequence[SurveyAnswerRow]) -> dict[RatingKey, RatingMean]:
    """Stand-in for T3.4's ``pipeline.survey.semester_rating_means``.

    Built to T3.4's description: the mean of each round's mean, plus the
    distinct respondents with a non-null answer and the rounds counted. A
    question with only N/A answers produces no value. Replace this with
    ``from ..survey import semester_rating_means`` once T3.4 merges.
    """

    respondents: dict[RatingKey, set[str]] = {}
    for answer in answers:
        if answer.value is not None:
            key = (answer.project_pk, answer.ratee_pk, answer.question_key)
            respondents.setdefault(key, set()).add(answer.respondent_pk)
    return {
        key: RatingMean(
            *key,
            mean=fmean(rounds.values()),
            respondent_count=len(respondents[key]),
            rounds_counted=len(rounds),
        )
        for key, rounds in round_means(answers).items()
    }


@dataclass(frozen=True)
class RatingTables:
    """The run's rating means and, for evidence, the round means behind them."""

    means: dict[RatingKey, RatingMean]
    rounds: dict[RatingKey, dict[str, float]]

    @classmethod
    def build(cls, answers: Iterable[SurveyAnswerRow], as_of: datetime) -> RatingTables:
        """Only submitted answers count, and only those submitted by as_of, as for
        the other latest-state sources. Nobody's rating of themselves counts, and
        only respondents in the question's roles (``RESPONDENT_ROLES``) count.
        """

        counted = [
            answer
            for answer in answers
            if answer.submitted_at is not None
            and answer.submitted_at <= as_of
            and answer.respondent_pk != answer.ratee_pk
            and counts_respondent(answer)
        ]
        return cls(means=_semester_rating_means(counted), rounds=round_means(counted))


def rating(
    member: RankedMember, question_key: str, tables: RatingTables, *, min_respondents: int = 1
) -> Measurement:
    key = (member.project_pk, member.authentik_user_pk, question_key)
    mean = tables.means.get(key)
    if mean is None:
        return Measurement(None, NO_RATINGS, {"round_means": {}})
    evidence = {
        "round_means": tables.rounds.get(key, {}),
        "respondent_count": mean.respondent_count,
        "rounds_counted": mean.rounds_counted,
    }
    if mean.respondent_count < min_respondents:
        return Measurement(None, TOO_FEW_RESPONDENTS, evidence)
    return Measurement(mean.mean, evidence=evidence)


def compute_member_rating_metrics(
    member: RankedMember, role_rubric: RoleRubric, tables: RatingTables
) -> list[MetricValue]:
    min_respondents = LEAD_MIN_RESPONDENTS if member.role == "tech_lead" else 1
    return rubric_rows(
        member,
        role_rubric,
        METRIC_KEYS,
        lambda key: rating(member, key, tables, min_respondents=min_respondents),
    )


def compute_run_rating_metrics(
    members: Sequence[RankedMember],
    as_of: datetime,
    rubric: Rubric,
    answers: Iterable[SurveyAnswerRow],
) -> list[MetricValue]:
    tables = RatingTables.build(answers, as_of)
    return [
        value
        for member in members
        for value in compute_member_rating_metrics(member, rubric.roles[member.role], tables)
    ]
