"""Shared resources. None of these is an asset.

A clone is an ephemeral working directory and a connection is a handle, not a
data artifact, so neither belongs in the asset graph -- keeping them here is
what lets assets return records instead of tempdir paths.

``GiteaClient`` and ``GitWorkspace`` are the source and capture resources;
``PostgresResource`` is imported from the storage boundary for the L4 feature
assets.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse
from uuid import uuid4

import httpx
from dagster import ConfigurableResource

from .config import PipelineConfigError, PipelineSettings, get_pipeline_settings
from .storage import PostgresResource

# The blame invocation, in one place because two things depend on it agreeing:
# the flags git is run with, and the header line written above each captured
# file. -M and -C follow moves and copies, so a refactor that relocates a block
# does not silently reassign its lines to whoever moved them. -w ignores
# whitespace-only changes, so a reformat does not do the same.
BLAME_FLAGS: tuple[str, ...] = ("--line-porcelain", "-w", "-M", "-C")

# git is run without a terminal, so anything that would prompt must fail
# instead of hanging a materialization forever. BatchMode covers the ssh key
# passphrase and password prompts; GIT_TERMINAL_PROMPT covers git's own.
# StrictHostKeyChecking is deliberately left alone: an unknown host should be
# an error a human sees, not something the pipeline quietly accepts.
_GIT_ENV = {
    "GIT_TERMINAL_PROMPT": "0",
    "GIT_SSH_COMMAND": "ssh -o BatchMode=yes",
}

# Listing a clone's files is local and instant. This is a guard against a
# wedged process, not a knob worth exposing as resource config.
_LS_FILES_TIMEOUT_SECONDS = 120.0
_PEOPLEPORTAL_USER_PATH = "peopleportal.atheesh.org/onboardeduser"
_GITEA_PAGE_SIZE = 50
_GITEA_MAX_PAGES = 10_000


class GiteaError(RuntimeError):
    """Gitea answered, but not with what was asked for."""


class AuthentikError(RuntimeError):
    """Authentik answered, but not with a complete People Portal roster."""


class GitCommandError(RuntimeError):
    """A git subprocess failed.

    Carries git's stderr, which is the only part of the failure that ever says
    why -- an exit status alone sends you back to the machine to reproduce it.
    """


@dataclass(frozen=True)
class Repository:
    """The three things blame needs about a repo, and nothing else.

    No commit list, no branch list, no per-sha enrichment: that is what makes
    the source layer one API call per repo instead of hundreds.
    """

    org: str
    name: str
    ssh_url: str
    default_branch: str
    empty: bool = False

    @property
    def slug(self) -> str:
        return f"{self.org}/{self.name}"


@dataclass(frozen=True)
class AuthentikUser:
    """One user returned by People Portal's Authentik-backed roster query."""

    authentik_user_pk: str
    username: str
    email: str
    name: str
    active: bool
    retrieved_at: datetime


@dataclass(frozen=True)
class AuthentikRoster:
    """A complete roster snapshot and the time Horizon finished fetching it."""

    users: list[AuthentikUser]
    retrieved_at: datetime


@dataclass(frozen=True)
class PullRequest:
    """The stable identifier needed to read one repository pull request."""

    number: int


@dataclass(frozen=True)
class PullRequestReview:
    """A Gitea review event with only the fields required for deterministic counts."""

    pull_request_number: int
    review_id: int
    reviewer_login: str
    state: str
    submitted_at: datetime | None

    @property
    def is_submitted(self) -> bool:
        return self.state in {"COMMENT", "APPROVED", "REQUEST_CHANGES"}


@dataclass(frozen=True)
class PullRequestCommit:
    """Commit message and author data returned in a pull request's commit list."""

    organization: str
    repository: str
    pull_request_number: int
    commit_sha: str
    author_name: str
    author_email: str
    committed_at: datetime
    message: str


@dataclass(frozen=True)
class PullRequestReviewSnapshot:
    """Complete review source snapshot for one repository and retrieval time."""

    organization: str
    repository: str
    pull_request_count: int
    reviews: list[PullRequestReview]
    retrieved_at: datetime


@dataclass(frozen=True)
class GitResult:
    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def run_git(
    args: Sequence[str],
    *,
    timeout: float,
    check: bool = True,
) -> GitResult:
    """Run one git command and decode its output defensively.

    Output is decoded with ``errors="replace"`` rather than strictly: source
    files are not required to be valid UTF-8, and a single stray byte in one
    repo must not take down the capture of every other file in it.
    """

    try:
        completed = subprocess.run(
            ["git", *args],
            capture_output=True,
            timeout=timeout,
            env={**os.environ, **_GIT_ENV},
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        raise GitCommandError(
            f"git {' '.join(args)} timed out after {timeout:.0f}s"
        ) from exc
    except OSError as exc:
        raise GitCommandError(f"git {' '.join(args)} could not start: {exc}") from exc

    result = GitResult(
        returncode=completed.returncode,
        stdout=completed.stdout.decode("utf-8", "replace"),
        stderr=completed.stderr.decode("utf-8", "replace"),
    )
    if check and not result.ok:
        raise GitCommandError(
            f"git {' '.join(args)} failed ({result.returncode}): "
            f"{result.stderr.strip() or 'no stderr'}"
        )
    return result


class GiteaClient(ConfigurableResource):
    """Read-only Gitea REST client (httpx), used to describe repositories.

    Not the curl-subprocess client the legacy code used; that workaround exists
    for rendered commit pages, which this pipeline never touches.
    """

    base_url: str | None = None
    api_token: str | None = None
    timeout_seconds: float = 30.0

    def get_repository(self, org: str, name: str) -> Repository:
        """Describe one repository. Exactly one API call."""

        payload = self._get_json(f"/repos/{org}/{name}")

        # Prefer the names Gitea echoes back. Org and repo names are matched
        # case-insensitively by the API but stored case-sensitively in every
        # table downstream, so taking the caller's spelling would let the same
        # repo arrive under two identities across runs.
        owner = payload.get("owner") or {}
        resolved_org = str(owner.get("login") or org)
        resolved_name = str(payload.get("name") or name)

        ssh_url = str(payload.get("ssh_url") or "")
        if not ssh_url:
            raise GiteaError(
                f"{resolved_org}/{resolved_name} has no ssh_url. Blame clones over "
                "SSH; git-over-HTTP is disabled on this deployment."
            )

        default_branch = str(payload.get("default_branch") or "")
        if not default_branch:
            raise GiteaError(
                f"{resolved_org}/{resolved_name} has no default_branch -- it is "
                "most likely an empty repository."
            )

        return Repository(
            org=resolved_org,
            name=resolved_name,
            ssh_url=ssh_url,
            default_branch=default_branch,
            empty=bool(payload.get("empty", False)),
        )

    def get_pull_request_reviews(
        self, repository: Repository
    ) -> PullRequestReviewSnapshot:
        """Fetch all pull requests and every paginated review attached to them."""

        api_base = self._api_base()
        api_path = self._repository_api_path(repository)
        reviews: list[PullRequestReview] = []
        seen_review_ids: set[tuple[int, int]] = set()

        try:
            with httpx.Client(
                timeout=self.timeout_seconds,
                headers=self._headers(),
                follow_redirects=True,
            ) as client:
                pull_payloads = self._get_paginated_list(
                    client,
                    api_base,
                    f"{api_path}/pulls",
                    params={"state": "all"},
                )
                pull_requests = [self._parse_pull_request(item) for item in pull_payloads]
                if len({item.number for item in pull_requests}) != len(pull_requests):
                    raise GiteaError(
                        f"Gitea returned duplicate pull request numbers for {repository.slug}."
                    )

                for pull_request in pull_requests:
                    review_payloads = self._get_paginated_list(
                        client,
                        api_base,
                        f"{api_path}/pulls/{pull_request.number}/reviews",
                    )
                    for payload in review_payloads:
                        review = self._parse_pull_request_review(
                            pull_request.number,
                            payload,
                            repository.slug,
                        )
                        key = (review.pull_request_number, review.review_id)
                        if key in seen_review_ids:
                            raise GiteaError(
                                f"Gitea returned duplicate review IDs for PR "
                                f"{pull_request.number} in {repository.slug}."
                            )
                        seen_review_ids.add(key)
                        reviews.append(review)
        except httpx.HTTPError as exc:
            raise GiteaError(
                f"Gitea pull request review request failed: {type(exc).__name__}."
            ) from exc

        return PullRequestReviewSnapshot(
            organization=repository.org,
            repository=repository.name,
            pull_request_count=len(pull_requests),
            reviews=reviews,
            retrieved_at=datetime.now(timezone.utc),
        )

    def get_pull_request_commits(
        self, repository: Repository
    ) -> list[PullRequestCommit]:
        """Fetch commit messages attached to PRs only, never repository activity."""

        api_base = self._api_base()
        api_path = self._repository_api_path(repository)
        commits: list[PullRequestCommit] = []
        seen_commits: set[tuple[int, str]] = set()

        try:
            with httpx.Client(
                timeout=self.timeout_seconds,
                headers=self._headers(),
                follow_redirects=True,
            ) as client:
                pull_payloads = self._get_paginated_list(
                    client,
                    api_base,
                    f"{api_path}/pulls",
                    params={"state": "all"},
                )
                pull_requests = [self._parse_pull_request(item) for item in pull_payloads]
                if len({item.number for item in pull_requests}) != len(pull_requests):
                    raise GiteaError(
                        f"Gitea returned duplicate pull request numbers for {repository.slug}."
                    )

                for pull_request in pull_requests:
                    commit_payloads = self._get_paginated_list(
                        client,
                        api_base,
                        f"{api_path}/pulls/{pull_request.number}/commits",
                        params={"verification": "false", "files": "false"},
                    )
                    for payload in commit_payloads:
                        commit = self._parse_pull_request_commit(
                            repository,
                            pull_request.number,
                            payload,
                        )
                        key = (commit.pull_request_number, commit.commit_sha)
                        if key in seen_commits:
                            raise GiteaError(
                                f"Gitea returned duplicate commit {commit.commit_sha} "
                                f"for PR {pull_request.number} in {repository.slug}."
                            )
                        seen_commits.add(key)
                        commits.append(commit)
        except httpx.HTTPError as exc:
            raise GiteaError(
                f"Gitea pull request commit request failed: {type(exc).__name__}."
            ) from exc

        return commits

    def _get_paginated_list(
        self,
        client: httpx.Client,
        api_base: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> list[dict]:
        """Fetch a complete Gitea list using its count and Link pagination contract.

        Gitea documents ``X-Total-Count`` and Link headers for paginated API
        responses. Requiring both the advertised total and contiguous next-page
        links prevents an absent or truncated page from being treated as a
        complete source snapshot.
        """

        items: list[dict] = []
        expected_total: int | None = None
        page = 1

        while True:
            if page > _GITEA_MAX_PAGES:
                raise GiteaError(f"Gitea pagination exceeded {_GITEA_MAX_PAGES} pages for {path}.")
            query = {**(params or {}), "page": str(page), "limit": str(_GITEA_PAGE_SIZE)}
            url = f"{api_base}{path}"
            try:
                response = client.get(url, params=query)
            except httpx.HTTPError:
                raise

            if response.status_code >= 400:
                raise GiteaError(
                    f"GET {url} page {page} returned {response.status_code}: "
                    f"{response.text[:200]}"
                )
            try:
                payload = response.json()
            except ValueError as exc:
                raise GiteaError(f"GET {url} page {page} did not return JSON.") from exc
            if not isinstance(payload, list) or not all(
                isinstance(item, dict) for item in payload
            ):
                raise GiteaError(
                    f"GET {url} page {page} did not return a JSON array of objects."
                )

            # Gitea's current general pagination contract uses X-Total-Count;
            # older pull-request commit endpoints documented X-Total instead.
            total_header = response.headers.get("X-Total-Count") or response.headers.get(
                "X-Total"
            )
            try:
                total = int(total_header) if total_header is not None else -1
            except ValueError as exc:
                raise GiteaError(
                    f"GET {url} page {page} returned invalid X-Total-Count."
                ) from exc
            if total < 0:
                raise GiteaError(
                    f"GET {url} page {page} omitted a valid X-Total-Count/X-Total; "
                    "cannot verify pagination completeness."
                )
            if expected_total is None:
                expected_total = total
            elif total != expected_total:
                raise GiteaError(
                    f"Gitea result count changed while retrieving {path}; "
                    "retry the materialization to avoid saving a partial snapshot."
                )

            page_header = response.headers.get("X-Page")
            if page_header is not None and page_header != str(page):
                raise GiteaError(
                    f"GET {url} requested page {page} but Gitea returned page {page_header}."
                )

            items.extend(payload)
            if len(items) > expected_total:
                raise GiteaError(
                    f"Gitea returned more rows than X-Total-Count for {path}."
                )

            next_page = self._next_page(response.headers.get("Link", ""))
            if next_page is None:
                if len(items) != expected_total:
                    raise GiteaError(
                        f"Gitea pagination ended after {len(items)} of "
                        f"{expected_total} rows for {path}."
                    )
                return items
            if next_page != page + 1 or not payload:
                raise GiteaError(
                    f"Gitea returned a non-contiguous or empty next page for {path}."
                )
            page = next_page

    @staticmethod
    def _next_page(link_header: str) -> int | None:
        """Read the next page number from a Gitea Link response header."""

        for link in link_header.split(","):
            match = re.match(r'\s*<([^>]+)>\s*;\s*rel="?([^";]+)', link)
            if not match or match.group(2).strip() != "next":
                continue
            page_values = parse_qs(urlparse(match.group(1)).query).get("page", [])
            if len(page_values) != 1:
                raise GiteaError("Gitea next-page Link omitted a single page parameter.")
            try:
                return int(page_values[0])
            except ValueError as exc:
                raise GiteaError("Gitea next-page Link contained an invalid page number.") from exc
        return None

    @staticmethod
    def _parse_pull_request(payload: dict) -> PullRequest:
        number = payload.get("number")
        if isinstance(number, bool) or not isinstance(number, int) or number <= 0:
            raise GiteaError("Gitea pull request list contains an invalid PR number.")
        return PullRequest(number=number)

    @classmethod
    def _parse_pull_request_review(
        cls, pull_request_number: int, payload: dict, repository_slug: str
    ) -> PullRequestReview:
        review_id = payload.get("id")
        if isinstance(review_id, bool) or not isinstance(review_id, int) or review_id <= 0:
            raise GiteaError(
                f"Gitea review for PR {pull_request_number} in {repository_slug} "
                "has an invalid ID."
            )
        state = payload.get("state")
        allowed_states = {
            "APPROVED",
            "PENDING",
            "COMMENT",
            "REQUEST_CHANGES",
            "REQUEST_REVIEW",
        }
        if not isinstance(state, str) or state not in allowed_states:
            raise GiteaError(
                f"Gitea review {review_id} for PR {pull_request_number} has an invalid state."
            )
        user = payload.get("user")
        if not isinstance(user, dict):
            raise GiteaError(
                f"Gitea review {review_id} for PR {pull_request_number} has no reviewer object."
            )
        login = user.get("login")
        if not isinstance(login, str) or not login.strip():
            raise GiteaError(
                f"Gitea review {review_id} for PR {pull_request_number} has no reviewer login."
            )

        submitted_at: datetime | None = None
        if state in {"COMMENT", "APPROVED", "REQUEST_CHANGES"}:
            submitted_at = cls._parse_aware_datetime(
                payload.get("submitted_at"),
                f"Gitea review {review_id} submitted_at",
            )
        return PullRequestReview(
            pull_request_number=pull_request_number,
            review_id=review_id,
            reviewer_login=login,
            state=state,
            submitted_at=submitted_at,
        )

    @classmethod
    def _parse_pull_request_commit(
        cls, repository: Repository, pull_request_number: int, payload: dict
    ) -> PullRequestCommit:
        sha = payload.get("sha")
        if not isinstance(sha, str) or not sha.strip():
            raise GiteaError(
                f"Gitea commit for PR {pull_request_number} in {repository.slug} "
                "has no SHA."
            )
        commit = payload.get("commit")
        if not isinstance(commit, dict):
            raise GiteaError(f"Gitea commit {sha} has no commit object.")
        author = commit.get("author")
        committer = commit.get("committer")
        if not isinstance(author, dict) or not isinstance(committer, dict):
            raise GiteaError(f"Gitea commit {sha} omitted author or committer details.")
        author_name = author.get("name")
        author_email = author.get("email")
        message = commit.get("message")
        if not isinstance(author_name, str) or not author_name.strip():
            raise GiteaError(f"Gitea commit {sha} omitted its author name.")
        if not isinstance(author_email, str) or not author_email.strip():
            raise GiteaError(f"Gitea commit {sha} omitted its author email.")
        if not isinstance(message, str):
            raise GiteaError(f"Gitea commit {sha} omitted its commit message.")
        committed_at = cls._parse_aware_datetime(
            committer.get("date"), f"Gitea commit {sha} committer date"
        )
        return PullRequestCommit(
            organization=repository.org,
            repository=repository.name,
            pull_request_number=pull_request_number,
            commit_sha=sha,
            author_name=author_name,
            author_email=author_email,
            committed_at=committed_at,
            message=message,
        )

    @staticmethod
    def _parse_aware_datetime(value: object, label: str) -> datetime:
        if not isinstance(value, str) or not value.strip():
            raise GiteaError(f"{label} is missing or not a string.")
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise GiteaError(f"{label} is not a valid ISO-8601 timestamp.") from exc
        if parsed.tzinfo is None:
            raise GiteaError(f"{label} has no timezone offset.")
        return parsed.astimezone(timezone.utc)

    @staticmethod
    def _repository_api_path(repository: Repository) -> str:
        return (
            f"/repos/{quote(repository.org, safe='')}/"
            f"{quote(repository.name, safe='')}"
        )

    def _headers(self) -> dict[str, str]:
        headers = {"Accept": "application/json"}
        if self.api_token:
            headers["Authorization"] = f"token {self.api_token}"
        return headers

    def _get_json(self, path: str) -> dict:
        url = f"{self._api_base()}{path}"
        headers = {"Accept": "application/json"}
        if self.api_token:
            headers["Authorization"] = f"token {self.api_token}"

        try:
            with httpx.Client(
                timeout=self.timeout_seconds,
                headers=headers,
                follow_redirects=True,
            ) as client:
                response = client.get(url)
        except httpx.HTTPError as exc:
            raise GiteaError(f"GET {url} failed: {type(exc).__name__}: {exc}") from exc

        if response.status_code == 404:
            raise GiteaError(f"GET {url} returned 404 -- no such repository, or the token cannot see it.")
        if response.status_code >= 400:
            raise GiteaError(f"GET {url} returned {response.status_code}: {response.text[:200]}")

        try:
            payload = response.json()
        except ValueError as exc:
            raise GiteaError(f"GET {url} did not return JSON.") from exc

        if not isinstance(payload, dict):
            raise GiteaError(f"GET {url} returned {type(payload).__name__}, expected an object.")
        return payload

    def _api_base(self) -> str:
        if not (self.base_url or "").strip():
            raise PipelineConfigError(
                "HORIZON_GITEA_URL is not set. Export it, or add it to "
                "horizon/.env, before materializing gitea_repository."
            )
        return f"{self.base_url.strip().rstrip('/')}/api/v1"


class AuthentikClient(ConfigurableResource):
    """Read People Portal-managed users from its Authentik directory source.

    This intentionally mirrors People Portal's ``getUserList`` contract:
    ``GET /api/v3/core/users/`` filtered by the onboarded-user path. Unlike the
    People Portal user-facing route, this service-to-service client talks to
    Authentik directly and needs its own read-only API token.
    """

    base_url: str | None = None
    api_token: str | None = None
    timeout_seconds: float = 30.0

    def get_peopleportal_roster(self) -> AuthentikRoster:
        """Fetch every page; any failed or malformed page fails the roster."""

        api_base = self._api_base()
        headers = {
            "Accept": "application/json",
            "Authorization": f"Bearer {self._require_api_token()}",
        }
        raw_users: list[dict] = []
        total_pages: int | None = None

        try:
            with httpx.Client(
                timeout=self.timeout_seconds,
                headers=headers,
                follow_redirects=True,
            ) as client:
                page = 1
                while total_pages is None or page <= total_pages:
                    response = client.get(
                        f"{api_base}/core/users/",
                        params={"path": _PEOPLEPORTAL_USER_PATH, "page": page},
                    )
                    if response.status_code >= 400:
                        raise AuthentikError(
                            f"GET Authentik user page {page} returned "
                            f"{response.status_code}. Check the URL, token, and read permissions."
                        )

                    try:
                        payload = response.json()
                    except ValueError as exc:
                        raise AuthentikError(
                            f"GET Authentik user page {page} did not return JSON."
                        ) from exc

                    if not isinstance(payload, dict):
                        raise AuthentikError(
                            f"GET Authentik user page {page} returned a non-object response."
                        )
                    users = payload.get("results")
                    pagination = payload.get("pagination")
                    if not isinstance(users, list) or not isinstance(pagination, dict):
                        raise AuthentikError(
                            f"GET Authentik user page {page} omitted results or pagination."
                        )

                    page_count = pagination.get("total_pages")
                    if not isinstance(page_count, int) or page_count < 0:
                        raise AuthentikError(
                            f"GET Authentik user page {page} returned invalid total_pages."
                        )
                    if total_pages is None:
                        total_pages = page_count
                    elif page_count != total_pages:
                        raise AuthentikError(
                            "Authentik roster pagination changed during retrieval; "
                            "retry the materialization to avoid a partial roster."
                        )

                    if not all(isinstance(user, dict) for user in users):
                        raise AuthentikError(
                            f"GET Authentik user page {page} contained a non-object user."
                        )
                    raw_users.extend(users)
                    page += 1
        except httpx.HTTPError as exc:
            raise AuthentikError(
                f"Authentik roster request failed: {type(exc).__name__}."
            ) from exc

        retrieved_at = datetime.now(timezone.utc)
        parsed = [self._parse_user(user, retrieved_at) for user in raw_users]
        seen_pks: set[str] = set()
        for user in parsed:
            if user.authentik_user_pk in seen_pks:
                raise AuthentikError(
                    "Authentik roster returned a duplicate user PK; refusing to "
                    "build identity mappings from an inconsistent roster."
                )
            seen_pks.add(user.authentik_user_pk)
        return AuthentikRoster(users=parsed, retrieved_at=retrieved_at)

    def _parse_user(self, payload: dict, retrieved_at: datetime) -> AuthentikUser:
        pk_value = payload.get("pk")
        if (
            isinstance(pk_value, bool)
            or not isinstance(pk_value, (int, str))
            or not str(pk_value).strip()
        ):
            raise AuthentikError("Authentik roster contains a user without a PK.")
        if not isinstance(payload.get("is_active"), bool):
            raise AuthentikError(
                "Authentik roster contains a user without a boolean is_active field."
            )
        return AuthentikUser(
            authentik_user_pk=str(pk_value),
            username=self._text_field(payload, "username"),
            email=self._text_field(payload, "email"),
            name=self._text_field(payload, "name"),
            active=payload["is_active"],
            retrieved_at=retrieved_at,
        )

    def _text_field(self, payload: dict, field_name: str) -> str:
        value = payload.get(field_name)
        if value is None:
            return ""
        if not isinstance(value, str):
            raise AuthentikError(
                f"Authentik roster contains a non-string {field_name} field."
            )
        return value

    def _api_base(self) -> str:
        if not (self.base_url or "").strip():
            raise PipelineConfigError(
                "HORIZON_AUTHENTIK_URL is not set. Export it, or add it to "
                "horizon/.env, before materializing authentik_users."
            )
        return f"{self.base_url.strip().rstrip('/')}/api/v3"

    def _require_api_token(self) -> str:
        token = (self.api_token or "").strip()
        if not token:
            raise PipelineConfigError(
                "HORIZON_AUTHENTIK_API_TOKEN is not set. Provide a read-only "
                "Authentik API token before materializing authentik_users."
            )
        return token


class GitWorkspace(ConfigurableResource):
    """Owns the lifecycle of the throwaway clone that blame runs against.

    Clones are full, never shallow: ``git blame`` needs the whole history to
    attribute a line, and a truncated history silently reassigns ownership to
    the oldest commit it can see. ``--single-branch`` narrows which refs are
    fetched, not how far back they go, so it is safe here and ``--depth`` is
    not.
    """

    root: str | None = None
    keep_clones: bool = False
    clone_timeout_seconds: float = 900.0
    blame_timeout_seconds: float = 300.0

    def resolve_root(self) -> Path:
        """Where clones and captures live.

        Defaults under the system temp directory so a checkout never gains
        untracked multi-megabyte files. Point ``root`` at real storage when
        captures need to outlive a reboot.
        """

        base = Path(self.root) if self.root else Path(tempfile.gettempdir()) / "horizon-workspace"
        base.mkdir(parents=True, exist_ok=True)
        return base

    def capture_path(self, run_id: str, repository: Repository) -> Path:
        """Where one repository's raw blame text lands for one run.

        Run-scoped, because blame is a snapshot of now: two runs of the same
        repo are two different answers and neither may overwrite the other.
        """

        directory = self.resolve_root() / "captures" / _path_safe(run_id)
        directory.mkdir(parents=True, exist_ok=True)
        return directory / f"{_path_safe(repository.slug)}.blame.txt"

    @contextmanager
    def clone(self, repository: Repository) -> Iterator[Path]:
        """Clone the default branch into a scratch directory for the duration.

        The suffix keeps two concurrent runs of the same repo from sharing a
        directory; cleanup is in a ``finally`` so a failed blame does not leave
        a multi-gigabyte clone behind.
        """

        clones = self.resolve_root() / "clones"
        clones.mkdir(parents=True, exist_ok=True)
        destination = clones / f"{_path_safe(repository.slug)}-{uuid4().hex[:8]}"

        try:
            run_git(
                [
                    "clone",
                    "--quiet",
                    "--no-tags",
                    "--single-branch",
                    "--branch",
                    repository.default_branch,
                    repository.ssh_url,
                    str(destination),
                ],
                timeout=self.clone_timeout_seconds,
            )
        except Exception:
            shutil.rmtree(destination, ignore_errors=True)
            raise
        try:
            yield destination
        finally:
            if not self.keep_clones:
                shutil.rmtree(destination, ignore_errors=True)

    def head_commit_sha(self, clone: Path) -> str:
        """Return the exact source revision captured, not a moving branch name."""

        result = run_git(
            ["-C", str(clone), "rev-parse", "HEAD"],
            timeout=_LS_FILES_TIMEOUT_SECONDS,
        )
        sha = result.stdout.strip().lower()
        if not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", sha):
            raise GitCommandError("git rev-parse HEAD returned an invalid object ID.")
        return sha

    def list_tracked_files(self, clone: Path) -> list[str]:
        """Every file git tracks, unfiltered.

        No extension allowlist: classification happens after collection (PR 8),
        so that deciding a ``.yml`` file is not "source" never again means
        re-cloning every repository to find out what was thrown away.
        """

        result = run_git(
            ["-C", str(clone), "ls-files", "-z"],
            timeout=_LS_FILES_TIMEOUT_SECONDS,
        )
        return [path for path in result.stdout.split("\0") if path]

    def blame_file(self, clone: Path, path: str) -> str | None:
        """Porcelain blame for one file, or ``None`` if git could not blame it.

        Per-file rather than per-repo: one unblamable file returns None and the
        caller counts it, instead of aborting a capture that is otherwise
        complete. The count is reported, never silently dropped.
        """

        try:
            result = run_git(
                ["-C", str(clone), "blame", *BLAME_FLAGS, "--", path],
                timeout=self.blame_timeout_seconds,
                check=False,
            )
        except GitCommandError:
            return None
        return result.stdout if result.ok else None


def _path_safe(value: str) -> str:
    """Flatten a slug into one filename component."""

    return "".join(char if char.isalnum() or char in "._-" else "_" for char in value)


def build_resources(
    settings: PipelineSettings | None = None,
) -> dict[str, ConfigurableResource]:
    """Build the resource map from the environment.

    Missing values are passed through as ``None`` rather than raising, so the
    asset graph always loads; the ``require_*`` accessors on ``PipelineSettings``
    are what fail, at the point a run actually needs the value.
    """

    resolved = settings or get_pipeline_settings()
    return {
        "gitea": GiteaClient(
            base_url=resolved.gitea_url,
            api_token=resolved.gitea_api_token,
        ),
        "authentik": AuthentikClient(
            base_url=resolved.authentik_url,
            api_token=resolved.authentik_api_token,
        ),
        "workspace": GitWorkspace(),
        "postgres": PostgresResource(database_url=resolved.database_url),
    }
