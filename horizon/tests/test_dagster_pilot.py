import pytest

dg = pytest.importorskip("dagster")
from dagster_pilot.pilot import defs


def run(semester="2026-spring"):
    return defs.get_job_def("semester_pilot").execute_in_process(partition_key=semester)


def test_all_assets_materialize_and_order():
    result = run()
    assert result.success
    assert {e.event_specific_data.materialization.asset_key.to_user_string() for e in result.all_events if e.is_step_materialization} == {
        "people_members", "people_events", "people_team_hierarchy", "people_assignments", "people_questionnaires", "gitea_repositories", "gitea_commits", "gitea_pull_requests", "gitea_reviews", "deterministic_features", "member_ranking", "project_audit", "tl_pl_sow_matching"
    }


def test_features_are_reproducible_and_growth_uses_prior_period():
    a = run(); b = run()
    assert a.output_for_node("deterministic_features") == b.output_for_node("deterministic_features")
    assert a.output_for_node("deterministic_features")["features"]["alice"]["growth"]["value"] == 6


def test_unavailable_factors_are_not_zero_and_responsibility_is_four_dimensions():
    result = run(); features = result.output_for_node("deterministic_features")["features"]
    assert features["alice"]["experience_difficulty"]["status"] == "unavailable"
    assert features["alice"]["performance_consistency"]["status"] == "unavailable"
    assert features["alice"]["responsibility_index"]["value"] == 0.9


def test_ranking_has_components_and_audit_and_matching_show_gaps():
    result = run(); ranking = result.output_for_node("member_ranking"); audit = result.output_for_node("project_audit"); matching = result.output_for_node("tl_pl_sow_matching")
    assert ranking["ranked"][0]["components"]
    assert "experience_difficulty" in ranking["unavailable"]
    assert {x["issue"] for x in audit["flags"]} == {"missing_sow_mapping", "missing_repository_mapping", "partial_or_stale_activity"}
    assert any(x.get("status") == "unavailable" for x in matching["matches"])


def test_rerun_is_safe_and_failed_source_is_observable():
    first = run(); second = run()
    assert first.success and second.success
    assert len([e for e in second.all_events if e.is_step_materialization]) == 13

    @dg.asset(partitions_def=dg.StaticPartitionsDefinition(["2026-spring"]))
    def failing_source():
        raise RuntimeError("synthetic upstream unavailable")

    failing = dg.Definitions(assets=[failing_source], jobs=[dg.define_asset_job("failure", selection="*")]).get_job_def("failure")
    with pytest.raises(Exception, match="synthetic upstream unavailable"):
        failing.execute_in_process(partition_key="2026-spring")
