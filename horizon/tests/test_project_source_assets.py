"""T1.1: one blame/ownership run request per project repository."""

from pipeline.assets.project_sources import blame_run_requests


def test_blame_run_requests_one_per_repository():
    requests = list(blame_run_requests([("Atlas", "app"), ("Beacon", "api")]))
    assert [r.run_key for r in requests] == ["Atlas/app", "Beacon/api"]
    assert requests[0].job_name == "blame_ownership"
    assert requests[1].run_config == {
        "ops": {"gitea_repository": {"config": {"org": "Beacon", "repo": "api"}}}
    }
