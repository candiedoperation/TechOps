from dataclasses import replace
from datetime import date, datetime
from zoneinfo import ZoneInfo

from pipeline.ranking.members import RankedMember
from pipeline.ranking.metrics_survey import (
    RatingTables,
    SurveyAnswerRow,
    compute_member_rating_metrics,
    compute_run_rating_metrics,
)
from pipeline.ranking.rubric import load_rubric

NY = ZoneInfo("America/New_York")
AS_OF = datetime(2026, 11, 20, 12, tzinfo=NY)
RUBRIC = load_rubric("v1").rubric


def member(pk, role="engineer", excluded_buckets=()):
    return RankedMember(
        authentik_user_pk=pk,
        project_pk="p1",
        role=role,
        display_name=pk,
        role_title=None,
        project_name="SpaceApp",
        comparison_group="club:tech_lead" if role == "tech_lead" else "project:p1:engineer",
        tenure_semesters=1,
        window_start=date(2026, 8, 31),
        window_end=date(2026, 11, 20),
        excluded_buckets=excluded_buckets,
    )


def answer(question, round_id, respondent, ratee, value, *, project="p1", day="2026-10-01"):
    return SurveyAnswerRow(
        response_id=f"{round_id}-{respondent}-{ratee}",
        question_key=question,
        round_id=round_id,
        project_pk=project,
        respondent_pk=respondent,
        respondent_role="tech_lead",
        ratee_pk=ratee,
        ratee_role="engineer",
        value=value,
        submitted_at=datetime.fromisoformat(day).replace(tzinfo=NY),
    )


# The card's example for engineer c, question eng_design:
# September [3, 2] -> 2.5, October [2] -> 2.0, November only N/A -> skipped.
ANSWERS = [
    answer("eng_design", "sep", "t", "c", 3),
    answer("eng_design", "sep", "t2", "c", 2),
    answer("eng_design", "oct", "t", "c", 2),
    answer("eng_design", "nov", "t", "c", None),
    answer("eng_timeliness", "sep", "t", "c", None),  # only N/A
    answer("eng_design", "sep", "t", "other", 1),     # another ratee
    answer("eng_design", "sep", "t", "c", 1, project="p2"),  # another project
    answer("eng_design", "dec", "t", "c", 1, day="2026-12-01"),  # after as_of
    # Ratings of tech lead l: guidance from one engineer, design from two.
    answer("lead_guidance", "oct", "a", "l", 3),
    answer("lead_design", "oct", "a", "l", 3),
    answer("lead_design", "oct", "b", "l", 2),
]

TABLES = RatingTables.build(ANSWERS, AS_OF)


def metrics_for(person, tables):
    values = compute_member_rating_metrics(person, RUBRIC.roles[person.role], tables)
    return {value.metric_key: value for value in values}


def metrics(person):
    return metrics_for(person, TABLES)


def test_the_worked_rating_example_averages_round_means():
    value = metrics(member("c"))["eng_design"]

    assert value.raw_value == 2.25
    assert value.bucket_key == "peer_ratings"
    assert value.evidence == {
        "round_means": {"oct": 2.0, "sep": 2.5},
        "respondent_count": 2,
        "rounds_counted": 2,
    }


def test_a_question_with_only_na_answers_has_no_rating():
    values = metrics(member("c"))

    assert values["eng_timeliness"].raw_value is None
    assert values["eng_timeliness"].missing_reason == "no_ratings"
    assert values["eng_collaboration"].missing_reason == "no_ratings"


def test_engineers_get_the_four_peer_rating_rows():
    assert set(metrics(member("c"))) == {
        "eng_timeliness", "eng_proactiveness", "eng_design", "eng_collaboration",
    }


def test_tech_lead_ratings_need_two_respondents():
    values = metrics(member("l", "tech_lead"))

    assert values["lead_guidance"].raw_value is None
    assert values["lead_guidance"].missing_reason == "too_few_respondents"
    assert values["lead_guidance"].evidence["respondent_count"] == 1
    assert values["lead_design"].raw_value == 2.5
    assert values["lead_design"].bucket_key == "leadership_ratings"


def test_a_single_respondent_is_enough_for_an_engineer():
    tables = RatingTables.build([answer("eng_design", "oct", "t", "c", 3)], AS_OF)

    values = compute_member_rating_metrics(member("c"), RUBRIC.roles["engineer"], tables)

    assert {value.metric_key: value.raw_value for value in values}["eng_design"] == 3


def test_self_ratings_and_unsubmitted_answers_do_not_count():
    rows = [
        answer("eng_design", "oct", "c", "c", 3),  # c rating themself
        replace(answer("eng_design", "oct", "t2", "c", 3), submitted_at=None),
        answer("eng_design", "oct", "t", "c", 1),
    ]

    value = metrics_for(member("c"), RatingTables.build(rows, AS_OF))["eng_design"]

    assert value.raw_value == 1
    assert value.evidence["respondent_count"] == 1


def test_an_excluded_review_bucket_keeps_the_rating_rows():
    excluded = member("c", excluded_buckets=("review_collaboration",))

    assert metrics(excluded)["eng_design"].raw_value == 2.25


def test_a_whole_run_writes_each_roles_rating_rows_with_their_buckets():
    values = compute_run_rating_metrics(
        [member("c"), member("l", "tech_lead")], AS_OF, RUBRIC, ANSWERS
    )

    assert {(value.authentik_user_pk, value.metric_key, value.bucket_key) for value in values} == {
        ("c", "eng_timeliness", "peer_ratings"),
        ("c", "eng_proactiveness", "peer_ratings"),
        ("c", "eng_design", "peer_ratings"),
        ("c", "eng_collaboration", "peer_ratings"),
        ("l", "lead_proactiveness", "leadership_ratings"),
        ("l", "lead_design", "leadership_ratings"),
        ("l", "lead_stakeholder", "leadership_ratings"),
        ("l", "lead_guidance", "leadership_ratings"),
    }
