"""T1.1: Gitea organization repositories, pull requests, reviews and review requests."""

from datetime import datetime, timezone

import httpx
import pytest

from pipeline.resources import GiteaClient, GiteaError
from project_source_fixtures import PR, page, use_transport


def test_timeline_review_requests_are_paginated_and_filtered(monkeypatch):
    def request_event(event_id, login, **extra):
        return {"id": event_id, "type": "review_request", "created_at": "2026-10-01T12:00:00Z",
                "assignee": {"login": login} if login else None, **extra}

    def handler(request):
        path, number = request.url.path, request.url.params["page"]
        if path.endswith("/pulls"):
            return page([PR], 1, 1)
        if path.endswith("/reviews"):
            return page([{"id": 11, "state": "APPROVED", "user": {"login": "amy"},
                          "submitted_at": "2026-10-02T09:00:00Z"}], 1, 1)
        if path.endswith("/timeline"):
            if number == "1":
                return page([{"id": 1, "type": "comment"}, request_event(2, "amy")], 4, 1, next_page=2)
            return page([request_event(3, None), request_event(5, "bo", removed_assignee=True)], 4, 2)
        raise AssertionError(path)

    use_transport(monkeypatch, handler)
    result = GiteaClient(base_url="https://git.example").get_repository_pull_requests("Atlas", "app")
    [pull] = result.pull_requests
    assert (pull.number, pull.author_login, pull.merged, pull.body) == (4, "JDoe", True, "")
    assert pull.merged_at == datetime(2026, 10, 2, 14, 0, tzinfo=timezone.utc)
    assert (pull.base_branch, pull.head_branch) == ("main", "feat/login")
    assert [(r.review_id, r.reviewer_login) for r in result.reviews] == [(11, "amy")]
    # Second timeline page was read; team (no assignee) and removed requests skipped.
    assert [(r.event_id, r.requested_login) for r in result.review_requests] == [(2, "amy")]
    assert result.pull_request_total == 1


def test_truncated_timeline_fails(monkeypatch):
    def handler(request):
        if request.url.path.endswith("/pulls"):
            return page([PR], 1, 1)
        if request.url.path.endswith("/reviews"):
            return page([], 0, 1)
        return page([{"id": 1, "type": "comment"}], 3, 1)

    use_transport(monkeypatch, handler)
    with pytest.raises(GiteaError, match="ended after 1 of 3"):
        GiteaClient(base_url="https://git.example").get_repository_pull_requests("Atlas", "app")


def test_malformed_pull_request_fails(monkeypatch):
    use_transport(monkeypatch, lambda request: page([PR | {"merged_at": None}], 1, 1))
    with pytest.raises(GiteaError, match="merged but has no merged_at"):
        GiteaClient(base_url="https://git.example").get_repository_pull_requests("Atlas", "app")


def test_org_repositories_are_listed_across_pages(monkeypatch):
    def handler(request):
        if request.url.params["page"] == "1":
            return page([{"name": "app", "default_branch": "main", "owner": {"login": "Atlas"}}],
                        2, 1, next_page=2)
        return page([{"name": "old", "default_branch": "main", "archived": True}], 2, 2)

    use_transport(monkeypatch, handler)
    repos = GiteaClient(base_url="https://git.example").list_org_repositories("atlas")
    assert [(r.org, r.name, r.archived) for r in repos] == [("Atlas", "app", False), ("atlas", "old", True)]


def test_team_review_request_without_user_is_skipped_but_userless_review_still_fails(monkeypatch):
    # Real Gitea data (IonQ, review 412): a review requested from a team is listed
    # among reviews with state REQUEST_REVIEW and user null.
    reviews = [{"id": 11, "state": "APPROVED", "user": {"login": "amy"}, "submitted_at": "2026-10-02T09:00:00Z"},
               {"id": 12, "state": "REQUEST_REVIEW", "user": None, "submitted_at": "2026-10-02T09:00:00Z"}]

    def handler(request):
        path = request.url.path
        if path.endswith("/pulls"):
            return page([PR], 1, 1)
        if path.endswith("/reviews"):
            return page(reviews, len(reviews), 1)
        return page([], 0, 1)

    use_transport(monkeypatch, handler)
    result = GiteaClient(base_url="https://git.example").get_repository_pull_requests("Atlas", "app")
    assert [r.review_id for r in result.reviews] == [11]
    reviews[1] = {"id": 13, "state": "APPROVED", "user": None, "submitted_at": "2026-10-02T09:00:00Z"}
    with pytest.raises(GiteaError, match="no reviewer object"):
        GiteaClient(base_url="https://git.example").get_repository_pull_requests("Atlas", "app")


def _commit_handler(state, commits_status):
    def handler(request):
        path = request.url.path
        if path.endswith("/pulls"):
            return page([PR | {"state": state}], 1, 1)
        if path.endswith("/commits"):
            if commits_status == 500:
                return httpx.Response(500, json={"message": "exit status 128: Stderr: fatal: bad revision 'gone...refs/pull/4/head'"})
            return page([], 0, 1)
        raise AssertionError(path)
    return handler


def test_closed_pr_whose_branch_is_gone_skips_only_its_commit_messages(monkeypatch):
    # Real Gitea data (Booz Allen PR #4): Gitea answers 500 "bad revision" because
    # the PR's source branch was deleted after merge.
    from pipeline.resources import Repository
    repo = Repository(org="Atlas", name="app", ssh_url="git@git.example:Atlas/app.git", default_branch="main")
    use_transport(monkeypatch, _commit_handler("closed", 500))
    assert GiteaClient(base_url="https://git.example").get_pull_request_commits(repo) == []


def test_open_pr_with_unresolvable_revision_still_fails(monkeypatch):
    from pipeline.resources import Repository
    repo = Repository(org="Atlas", name="app", ssh_url="git@git.example:Atlas/app.git", default_branch="main")
    use_transport(monkeypatch, _commit_handler("open", 500))
    with pytest.raises(GiteaError, match="cannot resolve the revision range"):
        GiteaClient(base_url="https://git.example").get_pull_request_commits(repo)
