#!/usr/bin/env python3
"""Build descriptive member analytics for one or more Gitea organizations.

The report intentionally measures observable repository activity rather than
assigning a performance score.  It includes every organization member,
including members with no recorded activity, and keeps admin/service accounts
flagged in the output.

Example::

    set -a; . ./.env; set +a
    .venv/bin/python scripts/member_analytics.py \
      --org AmazonLeoSPRING2026 \
      --org BoozAllenHamiltonSPRING2026 \
      --json data/appdev-member-analytics.json \
      --markdown data/appdev-member-analytics.md

The Gitea token is read from PHI_GITEA_API_TOKEN.  The blame pass replays the
Gitea API's commit diffs to attribute lines in each repository's default branch;
repositories are never modified.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from backend.gitea_evidence import MAX_REVIEW_CANDIDATES, METRIC_SEMANTICS, apply_collection_coverage, exact_identity_keys

PAGE_SIZE = 50
IdentityIndex = dict[str, str | set[str]]
MAX_PAGES = 200
DEFAULT_URL = "https://git.appdevclub.com"
SOURCE_EXTENSIONS = {
    ".c", ".cc", ".cpp", ".cs", ".css", ".feature", ".go", ".graphql",
    ".h", ".hh", ".hpp", ".html", ".ini", ".ipynb", ".java", ".js",
    ".jsx", ".json", ".kt", ".kts", ".md", ".php", ".pl", ".py",
    ".r", ".rb", ".rs", ".scss", ".sh", ".sql", ".swift", ".tf",
    ".toml", ".ts", ".tsx", ".vue", ".xml", ".yaml", ".yml", ".zsh",
}
SKIP_BLAME_NAMES = {
    "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "poetry.lock",
    "composer.lock", "go.sum", "cargo.lock", "pipfile.lock",
}
GENERIC_EMAIL_HOSTS = {
    "gmail", "googlemail", "outlook", "hotmail", "icloud", "yahoo",
    "users", "noreply", "localhost", "local",
}


def parse_ts(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = value if isinstance(value, datetime) else datetime.fromisoformat(
            str(value).replace("Z", "+00:00")
        )
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def clean_email(value: Any) -> str:
    text = str(value or "").strip().strip('<>"\u201c\u201d\u2018\u2019').casefold()
    return text


def clean_name(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).lower()


def identity_tokens(value: Any) -> list[str]:
    """Return alphanumeric identity tokens, excluding email domains."""
    text = str(value or "")
    if "@" in text:
        text = text.split("@", 1)[0]
    return re.findall(r"[a-z0-9]+", text.lower())


def identity_alias_keys(login: Any, name: Any, email: Any) -> set[str]:
    """Build exact and compact keys used to reconcile Git author aliases."""
    keys: set[str] = set()
    for value in (login, name):
        normalized = clean_name(value)
        if normalized:
            keys.add(normalized)
        tokens = identity_tokens(value)
        for token in tokens:
            if len(token) >= 4:
                keys.add(token)
                keys.add(re.sub(r"^\d+", "", token) or token)
        compact = "".join(tokens)
        if len(compact) >= 6:
            keys.add(compact)
    normalized_email = clean_email(email)
    if normalized_email:
        keys.add(normalized_email)
        local_part = normalized_email.split("@", 1)[0]
        keys.update(token for token in identity_tokens(local_part) if len(token) >= 4)
        for token in identity_tokens(local_part):
            if len(token) >= 4:
                keys.add(re.sub(r"^\d+", "", token) or token)
        compact_local = "".join(identity_tokens(local_part))
        if len(compact_local) >= 6:
            keys.add(compact_local)
        # Shared university/company domains identify a population, not a person.
    return keys


def commit_identities(raw: dict[str, Any]) -> dict[str, dict[str, str]]:
    """Return author and committer evidence without collapsing the two.

    Gitea may omit the account attached to a Git author.  In that case the
    committer account is not evidence that the committer authored the change;
    it is retained separately for auditability instead of being used as a
    fallback attribution.
    """

    commit = raw.get("commit") or {}
    git_author = commit.get("author") or {}
    git_committer = commit.get("committer") or {}
    author_account = raw.get("author") or {}
    committer_account = raw.get("committer") or {}

    def identity(account: dict[str, Any], git_identity: dict[str, Any]) -> dict[str, str]:
        login = account.get("login") or account.get("username") or ""
        name = git_identity.get("name") or account.get("full_name") or login
        email = clean_email(git_identity.get("email") or account.get("email"))
        return {"login": str(login), "name": str(name), "email": email}

    return {
        "author": identity(author_account, git_author),
        "committer": identity(committer_account, git_committer),
    }


class Gitea:
    def __init__(self, base_url: str, token: str) -> None:
        self.base_url = base_url.rstrip("/") + "/api/v1"
        self.token = token
        self.calls = 0
        self.failures: list[str] = []
        self.coverage: list[dict[str, Any]] = []

    def close(self) -> None:
        return None

    def _request(self, path: str, *, as_json: bool, **params: Any) -> Any:
        self.calls += 1
        last_error: Exception | None = None
        for attempt in range(2):
            try:
                query = urllib.parse.urlencode(params)
                url = f"{self.base_url}{path}"
                if query:
                    url += f"?{query}"
                # curl provides a process-level deadline.  This is important
                # for the deployed Gitea instance, whose proxy can leave an
                # HTTP/TLS response open indefinitely on some commit pages.
                config_file = tempfile.NamedTemporaryFile(
                    mode="w", prefix="appdev-gitea-curl-", suffix=".conf", delete=False
                )
                try:
                    os.chmod(config_file.name, 0o600)
                    config_file.write(
                        f'url = "{url}"\n'
                        f'header = "Authorization: token {self.token}"\n'
                        'header = "Accept: application/json"\n'
                    )
                    config_file.close()
                    curl_config = config_file.name
                except Exception:
                    config_file.close()
                    Path(config_file.name).unlink(missing_ok=True)
                    raise
                try:
                    response = subprocess.run(
                        [
                            "curl", "-sS", "--location", "--max-time", "20",
                            "--connect-timeout", "5",
                            "--config", curl_config,
                            "--write-out", "\n__HTTP_STATUS__%{http_code}\n",
                        ],
                        capture_output=True,
                        text=True,
                        timeout=30,
                        check=False,
                    )
                finally:
                    Path(curl_config).unlink(missing_ok=True)
                marker = "\n__HTTP_STATUS__"
                if marker not in response.stdout:
                    raise RuntimeError(response.stderr.strip() or "curl returned no HTTP status")
                body, status_text = response.stdout.rsplit(marker, 1)
                status = int(status_text.strip().splitlines()[0])
                if response.returncode != 0 or status >= 400:
                    detail = response.stderr.strip() or body[-300:].strip()
                    raise RuntimeError(f"HTTP {status}: {detail}")
                return json.loads(body) if as_json else body
            except (OSError, subprocess.TimeoutExpired, json.JSONDecodeError, ValueError, RuntimeError) as exc:
                last_error = exc
                if attempt == 0:
                    continue
        assert last_error is not None
        raise last_error

    def get(self, path: str, **params: Any) -> Any:
        return self._request(path, as_json=True, **params)

    def get_text(self, path: str, **params: Any) -> str:
        return self._request(path, as_json=False, **params)

    def _record_coverage(
        self,
        path: str,
        params: dict[str, Any],
        *,
        status: str,
        page_count: int,
        record_count: int,
        failed_page: int | None = None,
        error: str | None = None,
    ) -> None:
        event: dict[str, Any] = {
            "path": path,
            "params": {key: value for key, value in params.items() if key not in {"token", "authorization"}},
            "status": status,
            "page_count": page_count,
            "record_count": record_count,
        }
        if failed_page is not None:
            event["failed_page"] = failed_page
        if error:
            event["error"] = error
        self.coverage.append(event)

    def pages(self, path: str, **params: Any) -> list[Any]:
        items: list[Any] = []
        page_signatures: set[str] = set()
        for page in range(1, MAX_PAGES + 1):
            try:
                batch = self.get(path, page=page, limit=PAGE_SIZE, **params)
            except Exception as exc:  # noqa: BLE001 - preserve successful pages
                status = "partial" if items else "failed"
                message = f"{path} page {page}: {type(exc).__name__}: {exc}"
                self.failures.append(message)
                self._record_coverage(
                    path,
                    params,
                    status=status,
                    page_count=page - 1,
                    record_count=len(items),
                    failed_page=page,
                    error=str(exc),
                )
                print(f"   ! {message}", file=sys.stderr)
                return items
            if isinstance(batch, dict):
                if not isinstance(batch.get("data"), list):
                    raise RuntimeError(f"{path}: expected a list response, got an object without data[]")
                batch = batch["data"]
            if not isinstance(batch, list):
                raise RuntimeError(f"{path}: expected a list response, got {type(batch).__name__}")
            if not batch:
                self._record_coverage(
                    path, params, status="complete", page_count=page,
                    record_count=len(items),
                )
                break
            signature = json.dumps(batch, sort_keys=True, default=str)
            if signature in page_signatures:
                message = f"{path}: repeated page response at page {page}"
                self.failures.append(message)
                self._record_coverage(
                    path,
                    params,
                    status="partial",
                    page_count=page - 1,
                    record_count=len(items),
                    failed_page=page,
                    error="repeated page response",
                )
                print(f"   ! {message}", file=sys.stderr)
                return items
            page_signatures.add(signature)
            items.extend(batch)
            if len(batch) < PAGE_SIZE:
                self._record_coverage(
                    path, params, status="complete", page_count=page,
                    record_count=len(items),
                )
                break
            if page == MAX_PAGES:
                message = f"{path}: pagination reached MAX_PAGES={MAX_PAGES}"
                self.failures.append(message)
                self._record_coverage(
                    path,
                    params,
                    status="partial",
                    page_count=page,
                    record_count=len(items),
                    failed_page=page + 1,
                    error="pagination limit reached",
                )
                print(f"   ! {message}", file=sys.stderr)
        return items

    def try_pages(self, path: str, **params: Any) -> list[Any]:
        try:
            return self.pages(path, **params)
        except Exception as exc:  # noqa: BLE001 - keep one bad endpoint from stopping the audit
            message = f"{path}: {type(exc).__name__}: {exc}"
            self.failures.append(message)
            self._record_coverage(
                path,
                params,
                status="failed",
                page_count=0,
                record_count=0,
                error=str(exc),
            )
            print(f"   ! {message}", file=sys.stderr)
            return []


def org_members(api: Gitea, org: str) -> list[dict[str, Any]]:
    return api.try_pages(f"/orgs/{org}/members")


def org_repos(api: Gitea, org: str) -> list[dict[str, Any]]:
    return [repo for repo in api.try_pages(f"/orgs/{org}/repos") if not repo.get("empty")]


def discover_project_orgs(api: Gitea) -> list[str]:
    """Discover semester/project orgs without including personal accounts."""
    owners: set[str] = set()
    for repo in api.try_pages("/repos/search"):
        owner = repo.get("owner") or {}
        login = owner.get("login")
        if login and owner.get("source_id", 0) == 0:
            owners.add(str(login))
    # Include organizations that currently have no repositories.  They still
    # have roster members and must remain visible in a complete club report.
    for org in api.try_pages("/user/orgs"):
        login = org.get("username") or org.get("login")
        if login:
            owners.add(str(login))
    # App Dev Club project orgs conventionally carry a term in their slug.
    term = re.compile(r"(?:SPRING|SUMMER|FALL|WINTER)\d{4}", re.I)
    return sorted((org for org in owners if term.search(org)), key=str.lower)


def strong_identity_keys(login: Any, email: Any) -> set[str]:
    """Return typed identifiers that are safe for automatic attribution."""

    return exact_identity_keys(login, email)


def resolve_member_with_evidence(
    login: str,
    name: str,
    email: str,
    index: IdentityIndex,
    scoped_index: IdentityIndex | None = None,
    candidate_index: dict[str, set[str]] | None = None,
    scoped_candidate_index: dict[str, set[str]] | None = None,
    auto_match_candidates: bool = False,
) -> tuple[str, str, list[str]]:
    strong_keys = strong_identity_keys(login, email)
    strong_indexes = [
        (scope, lookup)
        for scope, lookup in (("organization", scoped_index), ("global", index))
        if lookup is not None
    ]
    def targets(value: Any) -> set[str]:
        return {value} if isinstance(value, str) else set(value or [])

    exact_by_scope = {
        scope: set().union(*(targets(lookup.get(key)) for key in strong_keys)) if strong_keys else set()
        for scope, lookup in strong_indexes
    }
    exact_matches = set().union(*exact_by_scope.values()) if exact_by_scope else set()
    if len(exact_matches) == 1:
        identity = next(iter(exact_matches))
        scope = "organization" if identity in exact_by_scope.get("organization", set()) else "global"
        matched_types = sorted(
            key.split(":", 1)[0]
            for key in strong_keys
            if any(identity in targets(lookup.get(key)) for _, lookup in strong_indexes)
        )
        return identity, f"{scope}_exact_{'_and_'.join(sorted(set(matched_types)))}", []

    # Names, email local parts, compact tokens, and substring similarities are
    # retained as review evidence only.  They must never silently change the
    # owner of an activity event: only typed login/email matches are automatic.
    candidate_keys = identity_alias_keys(login, name, email)
    candidate_indexes = [
        lookup
        for lookup in (scoped_candidate_index, candidate_index)
        if lookup is not None
    ]
    heuristic_candidates: set[str] = set()
    broad_match_suppressed = False
    for lookup in candidate_indexes:
        for key in candidate_keys:
            direct = lookup.get(key, set())
            if len(direct) > MAX_REVIEW_CANDIDATES:
                broad_match_suppressed = True
            else:
                heuristic_candidates.update(direct)
            if len(key) < 4:
                continue
            for alias, canonical in lookup.items():
                if len(alias) < 4 or alias == key:
                    continue
                if (
                    key.startswith(alias)
                    or alias.startswith(key)
                    or (len(alias) >= 5 and alias in key)
                ):
                    if len(canonical) > MAX_REVIEW_CANDIDATES:
                        broad_match_suppressed = True
                    else:
                        heuristic_candidates.update(canonical)
    if len(heuristic_candidates) > MAX_REVIEW_CANDIDATES:
        heuristic_candidates.clear()
        broad_match_suppressed = True
    candidates = sorted(exact_matches | heuristic_candidates, key=str.casefold)
    ambiguous = len(exact_matches) > 1
    unresolved_status = "heuristic_candidate_only" if candidates else "heuristic_candidates_suppressed" if broad_match_suppressed else None
    known_logins = set().union(*(targets(value) for _, lookup in strong_indexes for value in lookup.values()))

    # ``auto_match_candidates`` remains in the signature for compatibility
    # with older callers, but is intentionally ignored.  Alias approval must
    # be an explicit, reviewed mapping rather than a heuristic side effect.

    if login:
        identity = f"{login} [unmatched identity]" if ambiguous or login in known_logins else login
        resolution = (
            "ambiguous_strong_identity"
            if ambiguous
            else unresolved_status or "unmatched_login"
        )
        return identity, resolution, candidates
    if email:
        return (
            f"{name or '(unknown)'} <{email}>",
            "ambiguous_strong_identity"
            if ambiguous
            else unresolved_status or "unmatched_email",
            candidates,
        )
    return (
        f"{name} [unmatched identity]" if name in known_logins else name or "(unknown)",
        unresolved_status or "unmatched_name",
        candidates,
    )


def resolve_member(
    login: str,
    name: str,
    email: str,
    index: IdentityIndex,
    scoped_index: IdentityIndex | None = None,
    candidate_index: dict[str, set[str]] | None = None,
    scoped_candidate_index: dict[str, set[str]] | None = None,
    auto_match_candidates: bool = False,
) -> str:
    """Backward-compatible identity resolver returning only the canonical key."""

    identity, _, _ = resolve_member_with_evidence(
        login,
        name,
        email,
        index,
        scoped_index,
        candidate_index,
        scoped_candidate_index,
        auto_match_candidates,
    )
    return identity


def is_service_login(login: str) -> bool:
    """Recognize automation accounts so they are not compared with people.

    Unmatched commit identities arrive as "Name <email>", so only the handle
    ahead of the address is considered.
    """
    handle = login.lower().split("<", 1)[0].strip()
    if handle in {"gitadmin", "bot"}:
        return True
    return handle.endswith("[bot]") or handle.endswith("-bot") or handle.endswith("_bot")


def blank_metric(member: dict[str, Any], *, roster: bool = True) -> dict[str, Any]:
    login = str(member.get("login") or member.get("username") or "")
    return {
        "login": login,
        "name": member.get("full_name") or login,
        "email": clean_email(member.get("email")),
        "organizations": set(),
        "admin": bool(member.get("is_admin")),
        "active_account": bool(member.get("active", True)),
        "roster_member": roster,
        "service_or_admin": bool(member.get("is_admin")) or is_service_login(login),
        "commits": 0,
        "commits_default_reachable": 0,
        "commits_branch_only": 0,
        "non_merge_commits": 0,
        "merge_commits": 0,
        "additions": 0,
        "deletions": 0,
        "files_changed": 0,
        "unique_files": set(),
        "commit_stats_complete": 0,
        "commit_stats_unavailable": 0,
        "commit_stats_failed": 0,
        "file_stats_complete": 0,
        "file_stats_unavailable": 0,
        "file_stats_failed": 0,
        "repositories": set(),
        "branches": set(),
        "pulls_opened": 0,
        "pulls_merged": 0,
        "pulls_closed": 0,
        # Authored-PR metrics above intentionally remain distinct from
        # contribution-to-PR metrics below. A member can author commits that
        # land in a PR opened and merged by somebody else.
        "contributed_pull_ids": set(),
        "merged_contributed_pull_ids": set(),
        "pull_commit_keys": set(),
        "merged_pull_commit_keys": set(),
        "reviews_submitted": 0,
        "reviews_approved": 0,
        "reviews_changes_requested": 0,
        "reviews_other": 0,
        "issues_opened": 0,
        "active_days": set(),
        "first_activity": None,
        "last_activity": None,
        "blame_lines": None,
        "blame_files": None,
        "identity_aliases": {},
    }


def coverage_status(api: Gitea, path: str, start_index: int) -> str:
    """Return the observed status for one endpoint call without inventing zeros."""

    events = [event for event in api.coverage[start_index:] if event.get("path") == path]
    statuses = {str(event.get("status")) for event in events}
    if not statuses:
        return "unknown"
    if statuses == {"complete"}:
        return "complete"
    if "partial" in statuses:
        return "partial"
    if "complete" in statuses:
        return "partial"
    return "failed"


def add_pull_contribution(
    metric: dict[str, Any],
    *,
    pull_key: str,
    commit_sha: str,
    merged: bool,
) -> None:
    """Record authored commits that are members of a pull request.

    These are set-backed during collection so repeated API pages or duplicate
    commit rows cannot inflate the contribution counts. The PR author's own
    authored-PR counters remain separate in ``collect_repo``.
    """

    metric.setdefault("contributed_pull_ids", set()).add(pull_key)
    metric.setdefault("pull_commit_keys", set()).add(f"{pull_key}:{commit_sha}")
    if merged:
        metric.setdefault("merged_contributed_pull_ids", set()).add(pull_key)
        metric.setdefault("merged_pull_commit_keys", set()).add(f"{pull_key}:{commit_sha}")


def record_identity_alias(
    metric: dict[str, Any],
    *,
    login: str,
    name: str,
    email: str,
    resolved_identity: str,
    resolution: str,
    candidate_identities: list[str],
    event_type: str,
    organization: str,
    repository: str,
    when: datetime | None,
) -> None:
    """Retain raw contributor identity evidence without changing source values."""

    key = "\0".join(
        (login, name, email, resolved_identity, resolution, "\0".join(candidate_identities))
    )
    aliases = metric.setdefault("identity_aliases", {})
    alias = aliases.setdefault(
        key,
        {
            "login": login or None,
            "name": name or None,
            "email": email or None,
            "resolved_identity": resolved_identity,
            "resolution": resolution,
            "candidate_identities": set(candidate_identities),
            "event_types": set(),
            "organizations": set(),
            "repositories": set(),
            "event_count": 0,
            "first_seen": None,
            "last_seen": None,
        },
    )
    alias["event_types"].add(event_type)
    alias["candidate_identities"].update(candidate_identities)
    alias["organizations"].add(organization)
    alias["repositories"].add(f"{organization}/{repository}")
    alias["event_count"] += 1
    if when is not None:
        if alias["first_seen"] is None or when < alias["first_seen"]:
            alias["first_seen"] = when
        if alias["last_seen"] is None or when > alias["last_seen"]:
            alias["last_seen"] = when


def touch(metric: dict[str, Any], when: datetime | None) -> None:
    if not when:
        return
    day = when.strftime("%Y-%m-%d")
    metric["active_days"].add(day)
    if metric["first_activity"] is None or when < metric["first_activity"]:
        metric["first_activity"] = when
    if metric["last_activity"] is None or when > metric["last_activity"]:
        metric["last_activity"] = when


def metric_for(
    metrics: dict[str, dict[str, Any]],
    identity: str,
    fallback: dict[str, Any] | None = None,
) -> dict[str, Any]:
    if identity not in metrics:
        metrics[identity] = blank_metric({"login": identity, **(fallback or {})}, roster=False)
    return metrics[identity]


def update_commit(
    metrics: dict[str, dict[str, Any]],
    identity: str,
    commit: dict[str, Any],
    org: str,
    repo: str,
) -> None:
    metric = metric_for(metrics, identity)
    metric["organizations"].add(org)
    metric["repositories"].add(f"{org}/{repo}")
    metric["commits"] += 1
    if not commit.get("branches"):
        metric.setdefault("availability", {}).update(commits_default_reachable="partial", commits_branch_only="partial")
    elif "(default)" in set(commit.get("branches") or []):
        metric["commits_default_reachable"] += 1
    else:
        metric["commits_branch_only"] += 1
    merge = len(commit.get("parents") or []) > 1
    metric["merge_commits" if merge else "non_merge_commits"] += 1
    stats_status = str(commit.get("stats_status") or "unavailable")
    if stats_status == "complete":
        metric["commit_stats_complete"] += 1
        stats = commit.get("stats") or {}
        metric["additions"] += int(stats.get("additions") or 0)
        metric["deletions"] += int(stats.get("deletions") or 0)
    elif stats_status == "failed":
        metric["commit_stats_failed"] += 1
    else:
        metric["commit_stats_unavailable"] += 1

    files_status = str(commit.get("files_status") or "unavailable")
    if files_status == "complete":
        metric["file_stats_complete"] += 1
        files = commit.get("files") or []
        metric["files_changed"] += len(files)
        metric["unique_files"].update(str(f.get("filename")) for f in files if f.get("filename"))
    elif files_status == "failed":
        metric["file_stats_failed"] += 1
    else:
        metric["file_stats_unavailable"] += 1
    metric["branches"].update(commit.get("branches") or [])
    when = parse_ts(
        (commit.get("commit") or {}).get("committer", {}).get("date")
        or (commit.get("commit") or {}).get("author", {}).get("date")
        or commit.get("created")
    )
    touch(metric, when)


def native_history_commits(repo: dict[str, Any]) -> list[dict[str, Any]] | None:
    """Read all branch commit metadata from one native SSH clone.

    The deployed Gitea instance can leave one REST request per branch open for
    a long time.  Native Git already has the complete ref graph after one
    clone, so this is the reliable all-branches path.  The caller enriches
    every commit through the Gitea commit-detail endpoint so feature-branch
    line statistics are not silently converted into zeros.
    """
    ssh_url = str(repo.get("ssh_url") or "")
    if not ssh_url.startswith("git@") and not ssh_url.startswith("ssh://"):
        return None
    with tempfile.TemporaryDirectory(prefix="appdev-gitea-history-") as temp:
        destination = Path(temp) / re.sub(
            r"[^A-Za-z0-9_.-]+", "_", f"{repo['organization']}-{repo['name']}"
        )
        try:
            cloned = subprocess.run(
                [
                    "git", "clone", "--quiet", "--no-tags",
                    "--filter=blob:none", "--no-checkout", ssh_url, str(destination),
                ],
                capture_output=True,
                text=True,
                timeout=300,
                check=False,
            )
        except (subprocess.TimeoutExpired, OSError):
            return None
        if cloned.returncode != 0:
            return None

        refs = subprocess.run(
            [
                "git", "-C", str(destination), "for-each-ref",
                "--format=%(refname)\t%(refname:strip=3)", "refs/remotes/origin",
            ],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )
        branches: list[tuple[str, str]] = []
        for line in refs.stdout.splitlines():
            ref, separator, branch = line.partition("\t")
            if separator and branch and branch != "HEAD":
                branches.append((ref, branch))

        branch_commits: dict[str, set[str]] = defaultdict(set)
        for ref, branch in branches:
            revs = subprocess.run(
                ["git", "-C", str(destination), "rev-list", ref],
                capture_output=True,
                text=True,
                timeout=180,
                check=False,
            )
            for sha in revs.stdout.splitlines():
                branch_commits[sha].add(branch)
                if branch == repo.get("default_branch"):
                    branch_commits[sha].add("(default)")

        format_string = (
            "__COMMIT__%H%x00%P%x00%aN%x00%aE%x00%aI%x00"
            "%cN%x00%cE%x00%cI"
        )
        history = subprocess.run(
            [
                "git", "-C", str(destination), "log", "--all",
                "--date=iso-strict", f"--format={format_string}",
            ],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if history.returncode != 0:
            return None

        commits: list[dict[str, Any]] = []
        current: dict[str, Any] | None = None

        def finish() -> None:
            if current is None:
                return
            current.pop("_additions", None)
            current.pop("_deletions", None)
            current["stats"] = {}
            current["stats_status"] = "unavailable"
            current["files_status"] = "unavailable"
            # A missing ref observation is unknown, not proof that the commit
            # belongs to the default branch.
            current["branches"] = branch_commits.get(current["sha"], set())
            commits.append(current)

        for line in history.stdout.splitlines():
            if line.startswith("__COMMIT__"):
                finish()
                fields = line[len("__COMMIT__"):].split("\x00")
                if len(fields) != 8:
                    current = None
                    continue
                sha, parents, author_name, author_email, author_date, committer_name, committer_email, committer_date = fields
                current = {
                    "sha": sha,
                    "parents": [{"sha": parent} for parent in parents.split() if parent],
                    "author": {"login": "", "full_name": author_name, "email": author_email},
                    "committer": {"login": "", "full_name": committer_name, "email": committer_email},
                    "commit": {
                        "author": {"name": author_name, "email": author_email, "date": author_date},
                        "committer": {"name": committer_name, "email": committer_email, "date": committer_date},
                    },
                    "files": [],
                    "_additions": 0,
                    "_deletions": 0,
                }
                continue
        finish()
        return commits


def _apply_commit_detail(commit: dict[str, Any], raw: dict[str, Any]) -> None:
    """Copy diff fields from a Gitea commit response and mark coverage."""

    # Native history starts with Git name/email evidence and no Gitea account
    # object.  Preserve the API's author account when commit-detail enrichment
    # supplies it, but keep author and committer identities distinct.
    for field in ("author", "committer"):
        account = raw.get(field)
        if isinstance(account, dict):
            existing = commit.get(field) if isinstance(commit.get(field), dict) else {}
            commit[field] = {**existing, **account}
    raw_commit = raw.get("commit")
    if isinstance(raw_commit, dict):
        current_commit = commit.get("commit") if isinstance(commit.get("commit"), dict) else {}
        for field in ("author", "committer"):
            identity = raw_commit.get(field)
            if isinstance(identity, dict):
                existing_identity = current_commit.get(field) if isinstance(current_commit.get(field), dict) else {}
                current_commit[field] = {**existing_identity, **identity}
        commit["commit"] = current_commit

    stats = raw.get("stats")
    if (
        isinstance(stats, dict)
        and {"additions", "deletions"}.issubset(stats)
        and stats.get("additions") is not None
        and stats.get("deletions") is not None
    ):
        commit["stats"] = stats
        commit["stats_status"] = "complete"
    elif "stats" in raw and commit.get("stats_status") != "complete":
        commit["stats"] = stats if isinstance(stats, dict) else {}
        commit["stats_status"] = "unavailable"

    files = raw.get("files")
    if isinstance(files, list):
        commit["files"] = files
        commit["files_status"] = "complete"
    elif "files" in raw and commit.get("files_status") != "complete":
        commit["files"] = []
        commit["files_status"] = "unavailable"


def enrich_commit_details(api: Gitea, org: str, repo: str, commit: dict[str, Any]) -> None:
    """Recover stats for every selected commit, including feature branches."""

    if commit.get("stats_status") == "complete" and commit.get("files_status") == "complete":
        return
    sha = str(commit.get("sha") or commit.get("id") or "")
    if not sha:
        commit.setdefault("stats_status", "unavailable")
        commit.setdefault("files_status", "unavailable")
        return
    path = f"/repos/{org}/{repo}/git/commits/{sha}"
    try:
        detail = api.get(path)
    except Exception as exc:  # noqa: BLE001 - preserve the commit with explicit failure state
        message = f"{path}: {type(exc).__name__}: {exc}"
        api.failures.append(message)
        api.coverage.append({
            "path": path,
            "params": {},
            "status": "failed",
            "page_count": 1,
            "record_count": 0,
            "error": str(exc),
        })
        if commit.get("stats_status") != "complete":
            commit["stats_status"] = "failed"
        if commit.get("files_status") != "complete":
            commit["files_status"] = "failed"
        return
    if isinstance(detail, dict):
        _apply_commit_detail(commit, detail)
    commit.setdefault("stats_status", "unavailable")
    commit.setdefault("files_status", "unavailable")


def collect_repo(
    api: Gitea,
    org: str,
    repo: dict[str, Any],
    member_index: IdentityIndex,
    metrics: dict[str, dict[str, Any]],
    *,
    all_branches: bool,
    member_index_by_org: dict[str, IdentityIndex] | None = None,
    candidate_index: dict[str, set[str]] | None = None,
    candidate_index_by_org: dict[str, dict[str, set[str]]] | None = None,
    native_history: bool = False,
) -> dict[str, Any]:
    name = str(repo["name"])
    branches = [str(b["name"]) for b in api.try_pages(f"/repos/{org}/{name}/branches") if b.get("name")]
    refs: list[str | None] = [None] + (branches if all_branches else [])
    commits: dict[str, dict[str, Any]] = {}
    if all_branches and native_history:
        native_repo = {**repo, "organization": org, "name": name}
        native_commits = native_history_commits(native_repo)
        if native_commits is not None:
            commits = {str(raw["sha"]): raw for raw in native_commits if raw.get("sha")}
        else:
            print(
                f"   ! native all-branch history failed for {org}/{name}; falling back to REST",
                file=sys.stderr,
            )
    if not commits:
        for ref in refs:
            params = {"sha": ref} if ref else {}
            for raw in api.try_pages(f"/repos/{org}/{name}/commits", **params):
                sha = raw.get("sha") or raw.get("id")
                if not sha:
                    continue
                if sha not in commits:
                    commits[sha] = dict(raw)
                    commits[sha]["branches"] = set()
                commits[sha]["branches"].add(ref or "(default)")

    for commit in commits.values():
        if commit.get("stats_status") is None:
            _apply_commit_detail(commit, commit)
        if commit.get("files_status") is None:
            _apply_commit_detail(commit, commit)
        enrich_commit_details(api, org, name, commit)

    scoped_index = (member_index_by_org or {}).get(org)
    scoped_candidate_index = (candidate_index_by_org or {}).get(org)

    normalized_commits = []
    commit_stats_counts = defaultdict(int)
    file_stats_counts = defaultdict(int)
    for commit in commits.values():
        identities = commit_identities(commit)
        author_identity = identities["author"]
        committer_identity = identities["committer"]
        login = author_identity["login"]
        actor_name = author_identity["name"]
        email = author_identity["email"]
        identity, resolution, identity_candidates = resolve_member_with_evidence(
            login,
            actor_name,
            email,
            member_index,
            scoped_index,
            candidate_index,
            scoped_candidate_index,
            auto_match_candidates=False,
        )
        metric = metric_for(
            metrics,
            identity,
            {"full_name": actor_name, "email": email},
        )
        when = parse_ts(
            (commit.get("commit") or {}).get("committer", {}).get("date")
            or (commit.get("commit") or {}).get("author", {}).get("date")
            or commit.get("created")
        )
        record_identity_alias(
            metric,
            login=login,
            name=actor_name,
            email=email,
            resolved_identity=identity,
            resolution=resolution,
            candidate_identities=identity_candidates,
            event_type="commit",
            organization=org,
            repository=name,
            when=when,
        )
        update_commit(metrics, identity, commit, org, name)
        commit_stats_counts[str(commit.get("stats_status") or "unavailable")] += 1
        file_stats_counts[str(commit.get("files_status") or "unavailable")] += 1
        normalized_commits.append({
            "sha": commit.get("sha"),
            "author": identity,
            "author_identity": {
                "login": login or None,
                "name": actor_name or None,
                "email": email or None,
                "resolved_identity": identity,
                "resolution": resolution,
                "candidate_identities": identity_candidates,
            },
            "committer_identity": {
                "login": committer_identity["login"] or None,
                "name": committer_identity["name"] or None,
                "email": committer_identity["email"] or None,
            },
            "when": when,
            "branches": sorted(commit.get("branches") or []),
            "stats": commit.get("stats") or {},
            "stats_status": commit.get("stats_status") or "unavailable",
            "files_status": commit.get("files_status") or "unavailable",
        })

    pulls_path = f"/repos/{org}/{name}/pulls"
    pulls_coverage_start = len(api.coverage)
    pulls = api.try_pages(pulls_path, state="all")
    pulls_status = coverage_status(api, pulls_path, pulls_coverage_start)
    normalized_pulls = []
    review_statuses: list[str] = []
    pull_commit_statuses: list[str] = []
    for pull in pulls:
        author = pull.get("user") or {}
        raw_login = str(author.get("login") or author.get("username") or "")
        raw_name = str(author.get("full_name") or "")
        raw_email = clean_email(author.get("email"))
        identity, resolution, identity_candidates = resolve_member_with_evidence(
            raw_login,
            raw_name,
            raw_email,
            member_index,
            scoped_index,
            candidate_index,
            scoped_candidate_index,
            auto_match_candidates=False,
        )
        metric = metric_for(
            metrics,
            identity,
            {"full_name": raw_name, "email": raw_email},
        )
        metric["organizations"].add(org)
        metric["repositories"].add(f"{org}/{name}")
        created = parse_ts(pull.get("created_at"))
        record_identity_alias(
            metric,
            login=raw_login,
            name=raw_name,
            email=raw_email,
            resolved_identity=identity,
            resolution=resolution,
            candidate_identities=identity_candidates,
            event_type="pull",
            organization=org,
            repository=name,
            when=created,
        )
        touch(metric, created)
        metric["pulls_opened"] += 1
        merged = bool(pull.get("merged_at"))
        if merged:
            metric["pulls_merged"] += 1
            touch(metric, parse_ts(pull.get("merged_at")))
        elif pull.get("closed_at"):
            metric["pulls_closed"] += 1
            touch(metric, parse_ts(pull.get("closed_at")))

        pull_number = pull.get("number")
        pull_key = f"{org}/{name}#{pull_number}"
        contributing_identities: dict[str, dict[str, Any]] = {}
        if pull_number is None:
            pull_commit_status = "not_applicable"
        else:
            pull_commits_path = f"/repos/{org}/{name}/pulls/{pull_number}/commits"
            pull_commits_coverage_start = len(api.coverage)
            pull_commits = api.try_pages(pull_commits_path)
            pull_commit_status = coverage_status(api, pull_commits_path, pull_commits_coverage_start)
            for pull_commit in pull_commits:
                commit_sha = str(pull_commit.get("sha") or pull_commit.get("id") or "")
                if not commit_sha:
                    continue
                identities = commit_identities(pull_commit)
                pull_author = identities["author"]
                contributor_id, contributor_resolution, contributor_candidates = resolve_member_with_evidence(
                    pull_author["login"],
                    pull_author["name"],
                    pull_author["email"],
                    member_index,
                    scoped_index,
                    candidate_index,
                    scoped_candidate_index,
                    auto_match_candidates=False,
                )
                contributor_metric = metric_for(
                    metrics,
                    contributor_id,
                    {"full_name": pull_author["name"], "email": pull_author["email"]},
                )
                add_pull_contribution(
                    contributor_metric,
                    pull_key=pull_key,
                    commit_sha=commit_sha,
                    merged=merged,
                )
                commit_when = parse_ts(
                    (pull_commit.get("commit") or {}).get("committer", {}).get("date")
                    or (pull_commit.get("commit") or {}).get("author", {}).get("date")
                    or pull_commit.get("created")
                )
                record_identity_alias(
                    contributor_metric,
                    login=pull_author["login"],
                    name=pull_author["name"],
                    email=pull_author["email"],
                    resolved_identity=contributor_id,
                    resolution=contributor_resolution,
                    candidate_identities=contributor_candidates,
                    event_type="pull_commit",
                    organization=org,
                    repository=name,
                    when=commit_when,
                )
                entry = contributing_identities.setdefault(
                    contributor_id,
                    {
                        "identity": contributor_id,
                        "resolution": contributor_resolution,
                        "candidate_identities": contributor_candidates,
                        "commit_shas": [],
                        "author_identities": [],
                    },
                )
                entry["commit_shas"].append(commit_sha)
                if pull_author not in entry["author_identities"]:
                    entry["author_identities"].append(pull_author)
        pull_commit_statuses.append(pull_commit_status)

        reviewers = []
        reviews_path = f"/repos/{org}/{name}/pulls/{pull_number}/reviews"
        reviews_coverage_start = len(api.coverage)
        reviews = api.try_pages(reviews_path) if pull_number is not None else []
        review_statuses.append(
            coverage_status(api, reviews_path, reviews_coverage_start)
            if pull_number is not None
            else "not_applicable"
        )
        for review in reviews:
            reviewer = review.get("user") or {}
            reviewer_login = str(reviewer.get("login") or reviewer.get("username") or "")
            reviewer_name = str(reviewer.get("full_name") or "")
            reviewer_email = clean_email(reviewer.get("email"))
            reviewer_id, reviewer_resolution, reviewer_candidates = resolve_member_with_evidence(
                reviewer_login,
                reviewer_name,
                reviewer_email,
                member_index,
                scoped_index,
                candidate_index,
                scoped_candidate_index,
                auto_match_candidates=False,
            )
            review_metric = metric_for(
                metrics,
                reviewer_id,
                {"full_name": reviewer_name, "email": reviewer_email},
            )
            review_metric["organizations"].add(org)
            review_metric["repositories"].add(f"{org}/{name}")
            review_metric["reviews_submitted"] += 1
            state = str(review.get("state") or "").lower()
            if state == "approved":
                review_metric["reviews_approved"] += 1
            elif state in {"request_changes", "requested_changes", "changes_requested"}:
                review_metric["reviews_changes_requested"] += 1
            else:
                review_metric["reviews_other"] += 1
            reviewed_at = parse_ts(review.get("submitted_at") or review.get("created_at"))
            record_identity_alias(
                review_metric,
                login=reviewer_login,
                name=reviewer_name,
                email=reviewer_email,
                resolved_identity=reviewer_id,
                resolution=reviewer_resolution,
                candidate_identities=reviewer_candidates,
                event_type="review",
                organization=org,
                repository=name,
                when=reviewed_at,
            )
            touch(review_metric, reviewed_at)
            reviewers.append({
                "author": reviewer_id,
                "author_identity": {
                    "login": reviewer_login or None,
                    "name": reviewer_name or None,
                    "email": reviewer_email or None,
                    "resolved_identity": reviewer_id,
                    "resolution": reviewer_resolution,
                    "candidate_identities": reviewer_candidates,
                },
                "state": review.get("state"),
            })
        normalized_pulls.append({
            "number": pull.get("number"),
            "title": pull.get("title"),
            "author": identity,
            "author_identity": {
                "login": raw_login or None,
                "name": raw_name or None,
                "email": raw_email or None,
                "resolved_identity": identity,
                "resolution": resolution,
                "candidate_identities": identity_candidates,
            },
            "state": pull.get("state"),
            "merged": merged,
            "merged_at": parse_ts(pull.get("merged_at")),
            "merge_commit_sha": pull.get("merge_commit_sha"),
            "commit_evidence_status": pull_commit_status,
            "commit_count": sum(len(item["commit_shas"]) for item in contributing_identities.values()),
            "contributing_authors": [
                {
                    "identity": item["identity"],
                    "resolution": item["resolution"],
                    "candidate_identities": item["candidate_identities"],
                    "commit_shas": sorted(set(item["commit_shas"])),
                    "author_identities": item["author_identities"],
                }
                for item in sorted(contributing_identities.values(), key=lambda value: value["identity"].casefold())
            ],
            "reviewers": reviewers,
        })

    issues_path = f"/repos/{org}/{name}/issues"
    issues_coverage_start = len(api.coverage)
    issues = api.try_pages(issues_path, state="all", type="issues")
    issues_status = coverage_status(api, issues_path, issues_coverage_start)
    normalized_issues = []
    for issue in issues:
        author = issue.get("user") or {}
        raw_login = str(author.get("login") or author.get("username") or "")
        raw_name = str(author.get("full_name") or "")
        raw_email = clean_email(author.get("email"))
        identity, resolution, identity_candidates = resolve_member_with_evidence(
            raw_login,
            raw_name,
            raw_email,
            member_index,
            scoped_index,
            candidate_index,
            scoped_candidate_index,
            auto_match_candidates=False,
        )
        metric = metric_for(
            metrics,
            identity,
            {"full_name": raw_name, "email": raw_email},
        )
        metric["organizations"].add(org)
        metric["repositories"].add(f"{org}/{name}")
        metric["issues_opened"] += 1
        created_at = parse_ts(issue.get("created_at"))
        record_identity_alias(
            metric,
            login=raw_login,
            name=raw_name,
            email=raw_email,
            resolved_identity=identity,
            resolution=resolution,
            candidate_identities=identity_candidates,
            event_type="issue",
            organization=org,
            repository=name,
            when=created_at,
        )
        touch(metric, created_at)
        normalized_issues.append({
            "number": issue.get("number"),
            "title": issue.get("title"),
            "author": identity,
            "author_identity": {
                "login": raw_login or None,
                "name": raw_name or None,
                "email": raw_email or None,
                "resolved_identity": identity,
                "resolution": resolution,
                "candidate_identities": identity_candidates,
            },
            "state": issue.get("state"),
            "created_at": parse_ts(issue.get("created_at")),
            "updated_at": parse_ts(issue.get("updated_at")),
            "closed_at": parse_ts(issue.get("closed_at")),
            "html_url": issue.get("html_url"),
        })

    return {
        "organization": org,
        "name": name,
        "default_branch": repo.get("default_branch") or "main",
        "html_url": repo.get("html_url"),
        "branches": branches,
        "commits": normalized_commits,
        "pulls": normalized_pulls,
        "pulls_status": pulls_status,
        "reviews_status": (
            "not_applicable"
            if not review_statuses
            else "complete"
            if all(status == "complete" for status in review_statuses)
            else "failed"
            if all(status == "failed" for status in review_statuses)
            else "partial"
        ),
        "pull_commits_status": (
            "not_applicable"
            if not pull_commit_statuses
            else "complete"
            if all(status == "complete" for status in pull_commit_statuses)
            else "failed"
            if all(status == "failed" for status in pull_commit_statuses)
            else "partial"
        ),
        "issues": normalized_issues,
        "issues_status": issues_status,
        "issue_count": len(issues),
        "commit_stats": {
            "selected_commits": len(normalized_commits),
            "complete_commits": commit_stats_counts.get("complete", 0),
            "unavailable_commits": commit_stats_counts.get("unavailable", 0),
            "failed_commits": commit_stats_counts.get("failed", 0),
            "status": (
                "not_applicable"
                if not normalized_commits
                else "complete"
                if commit_stats_counts.get("complete", 0) == len(normalized_commits)
                else "failed"
                if not commit_stats_counts.get("complete", 0)
                else "partial"
            ),
        },
        "file_stats": {
            "selected_commits": len(normalized_commits),
            "complete_commits": file_stats_counts.get("complete", 0),
            "unavailable_commits": file_stats_counts.get("unavailable", 0),
            "failed_commits": file_stats_counts.get("failed", 0),
            "status": (
                "not_applicable"
                if not normalized_commits
                else "complete"
                if file_stats_counts.get("complete", 0) == len(normalized_commits)
                else "failed"
                if not file_stats_counts.get("complete", 0)
                else "partial"
            ),
        },
        "clone_url": repo.get("clone_url") or repo.get("ssh_url"),
        "ssh_url": repo.get("ssh_url") or "",
    }


HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def patch_path(value: str, prefix: str) -> str:
    value = value.split("\t", 1)[0].strip()
    if value == "/dev/null":
        return value
    return value[len(prefix):] if value.startswith(prefix) else value


def parse_diff_files(diff: str) -> Iterable[tuple[str, str, list[dict[str, Any]]]]:
    """Yield old path, new path, and hunks from a unified commit diff."""
    chunks = re.split(r"(?m)^diff --git .*$", diff)
    for chunk in chunks[1:]:
        lines = chunk.splitlines()
        old_path = new_path = None
        hunks: list[dict[str, Any]] = []
        current: dict[str, Any] | None = None
        for line in lines:
            if line.startswith("--- ") and old_path is None:
                old_path = patch_path(line[4:], "a/")
            elif line.startswith("+++ ") and new_path is None:
                new_path = patch_path(line[4:], "b/")
            elif line.startswith("@@ "):
                match = HUNK_RE.match(line)
                if match:
                    current = {
                        "old_start": int(match.group(1)),
                        "new_start": int(match.group(3)),
                        "lines": [],
                    }
                    hunks.append(current)
            elif current is not None and line and line[0] in {" ", "+", "-"}:
                current["lines"].append(line)
        if old_path is not None and new_path is not None and hunks:
            yield old_path, new_path, hunks


def apply_hunks(
    files: dict[str, list[str]],
    old_path: str,
    new_path: str,
    hunks: list[dict[str, Any]],
    owner: str,
) -> None:
    if new_path == "/dev/null":
        files.pop(old_path, None)
        return
    existing = files.pop(old_path, []) if old_path != new_path else files.get(old_path, [])
    output: list[str] = []
    old_cursor = 0
    for hunk in hunks:
        old_start = max(int(hunk["old_start"]) - 1, 0)
        output.extend(existing[old_cursor:old_start])
        old_cursor = old_start
        for line in hunk["lines"]:
            kind = line[0]
            if kind == " ":
                if old_cursor < len(existing):
                    output.append(existing[old_cursor])
                old_cursor += 1
            elif kind == "-":
                old_cursor += 1
            elif kind == "+":
                output.append(owner)
    output.extend(existing[old_cursor:])
    files[new_path] = output


def blame_repo(
    api: Gitea,
    repo: dict[str, Any],
    metrics: dict[str, dict[str, Any]],
) -> bool:
    """Replay default-branch diffs to attribute current lines to commit authors.

    Git-over-HTTP is disabled on this Gitea deployment, so a regular git clone
    is unavailable.  The Gitea API's ``git/commits/{sha}.diff`` endpoint gives
    us the same commit hunks; replaying them oldest-to-newest preserves line
    ownership for the current default-branch snapshot.
    """
    commits = [
        commit for commit in repo["commits"]
        if "(default)" in (commit.get("branches") or [])
    ]
    files: dict[str, list[str]] = {}
    complete = True
    for commit in reversed(commits):
        sha = commit.get("sha")
        if not sha:
            continue
        try:
            diff = api.get_text(
                f"/repos/{repo['organization']}/{repo['name']}/git/commits/{sha}.diff"
            )
        except Exception as exc:  # noqa: BLE001 - preserve other repos' results
            complete = False
            message = f"blame diff {repo['organization']}/{repo['name']}@{sha}: {type(exc).__name__}: {exc}"
            api.failures.append(message)
            print(f"   ! {message}", file=sys.stderr)
            continue
        for old_path, new_path, hunks in parse_diff_files(diff):
            apply_hunks(files, old_path, new_path, hunks, str(commit.get("author") or "(unknown)"))

    for relative, owners in files.items():
        if Path(relative).name.lower() in SKIP_BLAME_NAMES:
            continue
        if Path(relative).suffix.lower() not in SOURCE_EXTENSIONS:
            continue
        counts: dict[str, int] = defaultdict(int)
        for owner in owners:
            counts[owner] += 1
        for owner, lines in counts.items():
            metric = metric_for(metrics, owner)
            metric["blame_lines"] = int(metric.get("blame_lines") or 0) + lines
            metric["blame_files"] = int(metric.get("blame_files") or 0) + 1
    return complete


def native_blame_repo(
    repo: dict[str, Any],
    member_index: IdentityIndex,
    metrics: dict[str, dict[str, Any]],
    member_index_by_org: dict[str, IdentityIndex],
    candidate_index: dict[str, set[str]],
    candidate_index_by_org: dict[str, dict[str, set[str]]],
    root: Path,
    raw_output: Path | None = None,
) -> bool:
    """Run native git blame against an SSH clone of the default branch."""
    ssh_url = str(repo.get("ssh_url") or "")
    if not ssh_url.startswith("git@") and not ssh_url.startswith("ssh://"):
        print(f"   ! skipping native blame for {repo['organization']}/{repo['name']}: no SSH clone URL", file=sys.stderr)
        return False
    destination = root / re.sub(r"[^A-Za-z0-9_.-]+", "_", f"{repo['organization']}-{repo['name']}")
    try:
        subprocess.run(
            [
                "git", "clone", "--quiet", "--no-tags", "--single-branch",
                "--branch", repo["default_branch"], ssh_url, str(destination),
            ],
            capture_output=True,
            text=True,
            timeout=300,
            check=True,
        )
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as exc:
        print(f"   ! native blame clone failed for {repo['organization']}/{repo['name']}: {exc}", file=sys.stderr)
        return False

    complete = True
    try:
        try:
            files = subprocess.run(
                ["git", "-C", str(destination), "ls-files", "-z"],
                capture_output=True,
                check=True,
            ).stdout.decode("utf-8", "replace").split("\0")
        except (subprocess.CalledProcessError, OSError):
            return False
        for relative in files:
            if not relative or Path(relative).name.lower() in SKIP_BLAME_NAMES:
                continue
            if Path(relative).suffix.lower() not in SOURCE_EXTENSIONS:
                continue
            result = subprocess.run(
                ["git", "-C", str(destination), "blame", "--line-porcelain", "-w", "--", relative],
                capture_output=True,
                text=True,
                timeout=120,
                check=False,
            )
            if result.returncode != 0:
                complete = False
                continue
            if raw_output is not None:
                with raw_output.open("a", encoding="utf-8") as handle:
                    handle.write(
                        f"\n===== git blame --line-porcelain -w -- {repo['organization']}/{repo['name']}:{relative} =====\n"
                    )
                    handle.write(result.stdout)
            current_name = ""
            current_email = ""
            owners: dict[str, int] = defaultdict(int)
            for line in result.stdout.splitlines():
                if line.startswith("author "):
                    current_name = line[len("author "):]
                elif line.startswith("author-mail "):
                    current_email = clean_email(line[len("author-mail "):])
                elif line.startswith("\t"):
                    identity = resolve_member(
                        "",
                        current_name,
                        current_email,
                        member_index,
                        member_index_by_org.get(repo["organization"]),
                        candidate_index,
                        candidate_index_by_org.get(repo["organization"]),
                        auto_match_candidates=False,
                    )
                    owners[identity] += 1
            for identity, lines in owners.items():
                metric = metric_for(metrics, identity)
                metric["blame_lines"] = int(metric.get("blame_lines") or 0) + lines
                metric["blame_files"] = int(metric.get("blame_files") or 0) + 1
    finally:
        # The clone is a temporary read-only workspace for this report.
        shutil.rmtree(destination, ignore_errors=True)
    return complete


def jsonable(value: Any) -> Any:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, set):
        return sorted(value)
    if isinstance(value, dict):
        return {key: jsonable(item) for key, item in value.items()}
    if isinstance(value, list):
        return [jsonable(item) for item in value]
    return value


def finalize_metrics(metrics: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    rows = []
    for metric in metrics.values():
        row = dict(metric)
        row["organizations"] = sorted(row["organizations"])
        row["repositories"] = sorted(row["repositories"])
        row["branches"] = sorted(row["branches"])
        row["unique_files"] = len(row["unique_files"])
        row["pulls_contributed_to"] = len(row.pop("contributed_pull_ids", set()))
        row["pulls_merged_contributed_to"] = len(row.pop("merged_contributed_pull_ids", set()))
        row["pull_commits_authored"] = len(row.pop("pull_commit_keys", set()))
        row["merged_pull_commits_authored"] = len(row.pop("merged_pull_commit_keys", set()))
        commit_total = row.get("commits", 0)
        commit_complete = row.get("commit_stats_complete", 0)
        commit_failed = row.get("commit_stats_failed", 0)
        row["commit_stats_status"] = (
            "complete"
            if commit_total and commit_complete == commit_total
            else "not_applicable"
            if not commit_total
            else "failed"
            if not commit_complete and commit_failed == commit_total
            else "partial"
        )
        file_complete = row.get("file_stats_complete", 0)
        file_failed = row.get("file_stats_failed", 0)
        row["file_stats_status"] = (
            "complete"
            if commit_total and file_complete == commit_total
            else "not_applicable"
            if not commit_total
            else "failed"
            if not file_complete and file_failed == commit_total
            else "partial"
        )
        # A partial aggregate is not a zero.  Keep the numeric field only when
        # every selected commit supplied the relevant evidence.
        if row["commit_stats_status"] != "complete":
            row["additions"] = None
            row["deletions"] = None
        if row["file_stats_status"] != "complete":
            row["files_changed"] = None
            row["unique_files"] = None
        row["active_days"] = len(row["active_days"])
        row["first_activity"] = jsonable(row["first_activity"])
        row["last_activity"] = jsonable(row["last_activity"])
        aliases = []
        for alias in row.get("identity_aliases", {}).values():
            item = dict(alias)
            item["event_types"] = sorted(item["event_types"])
            item["candidate_identities"] = sorted(item["candidate_identities"], key=str.casefold)
            item["organizations"] = sorted(item["organizations"])
            item["repositories"] = sorted(item["repositories"])
            item["first_seen"] = jsonable(item["first_seen"])
            item["last_seen"] = jsonable(item["last_seen"])
            aliases.append(item)
        row["identity_aliases"] = sorted(
            aliases,
            key=lambda item: (
                str(item.get("email") or ""),
                str(item.get("login") or ""),
                str(item.get("name") or ""),
                str(item.get("resolution") or ""),
            ),
        )
        rows.append(row)
    return sorted(
        rows,
        key=lambda row: (
            row["service_or_admin"],
            not row.get("roster_member", True),
            -row["commits"],
            -row["pulls_opened"],
            -row["reviews_submitted"],
            row["login"].lower(),
        ),
    )


def write_markdown(
    path: Path,
    rows: list[dict[str, Any]],
    orgs: list[str],
    repo_count: int,
    failures: list[str],
    *,
    blame_method: str | None,
    blame_status: str,
) -> None:
    people = [row for row in rows if not row["service_or_admin"] and row.get("roster_member", True)]
    unmatched = [row for row in rows if not row.get("roster_member", True)]
    lines = [
        "# App Dev Club Gitea member analytics",
        "",
        "This is a descriptive activity report, not a performance score. Commit volume, line ownership, additions/deletions, and review counts are affected by task size, role, collaboration style, generated code, and repository history; they should not be used alone for personnel decisions.",
        "",
        f"Organizations: {len(orgs)}  |  Repositories: {repo_count}  |  Members: {len(rows)}  |  Roster people excluding flagged service/admin accounts: {len(people)}  |  Unmatched commit identities: {len(unmatched)}",
        "",
        "## Member activity",
        "",
        "| Member | Orgs | Commits | Additions | Deletions | Files | PRs | Reviews | Approved | Issues | Active days | Blame lines |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        label = row["name"] or row["login"]
        if row["service_or_admin"]:
            label += " ⚙️"
        if not row.get("roster_member", True):
            label += " ❓"
        blame_lines = row["blame_lines"] if row["blame_lines"] is not None else "—"
        lines.append(
            f"| {label} (`{row['login']}`) | {len(row['organizations'])} | {row['commits']} | {row['additions']} | {row['deletions']} | {row['unique_files']} | {row['pulls_opened']} | {row['reviews_submitted']} | {row['reviews_approved']} | {row['issues_opened']} | {row['active_days']} | {blame_lines} |"
        )
    lines.extend([
        "",
        "⚙️ rows are admin/service accounts and are shown for completeness but should not be compared with member rows.",
        "",
        "❓ rows are commit identities that could not be confidently matched to a Gitea roster member. They may duplicate a member row above and should not be read as separate people.",
        "",
        "## Scope",
        "",
        "- Commits were deduplicated by SHA across the selected branch history.",
        "- PR and review data includes all states visible to the token.",
        (
            f"- Blame status is {blame_status}; current-default-branch line ownership uses {blame_method}, and common dependency lockfiles are excluded."
            if blame_method
            else "- Blame status is disabled; line-ownership values are unavailable rather than zero."
        ),
        "- Unmatched commit identities remain separate unless ingestion can safely fold a unique same-organization alias into its roster row.",
    ])
    if failures:
        lines.extend(["", "## Collection warnings", ""])
        lines.extend(f"- `{failure}`" for failure in failures)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--token", default=os.getenv("PHI_GITEA_API_TOKEN", ""))
    parser.add_argument("--url", default=os.getenv("PHI_GITEA_URL", DEFAULT_URL))
    parser.add_argument("--org", action="append", help="Organization login; repeat for multiple orgs")
    parser.add_argument("--discover-project-orgs", action="store_true", help="Discover term-named project orgs")
    parser.add_argument("--default-branch-only", action="store_true", help="Skip feature-branch history")
    parser.add_argument("--no-blame", action="store_true", help="Skip current-branch line ownership attribution")
    parser.add_argument("--native-blame", action="store_true", help="Use native git blame through the repository SSH URL")
    parser.add_argument("--native-history", action="store_true", help="Use one native SSH clone for all-branch commit history")
    parser.add_argument("--raw-blame", type=Path, default=None, help="Write raw native git blame output to this file")
    parser.add_argument("--json", type=Path, default=Path("data/appdev-member-analytics.json"))
    parser.add_argument("--markdown", type=Path, default=Path("data/appdev-member-analytics.md"))
    args = parser.parse_args()
    if not args.token:
        sys.exit("No token. Set PHI_GITEA_API_TOKEN or pass --token.")
    if not args.org and not args.discover_project_orgs:
        sys.exit("Provide --org one or more times, or use --discover-project-orgs.")

    api = Gitea(args.url, args.token)
    try:
        orgs = list(args.org or [])
        if args.discover_project_orgs:
            orgs.extend(discover_project_orgs(api))
        orgs = sorted(set(orgs), key=str.lower)
        metrics: dict[str, dict[str, Any]] = {}
        member_index: IdentityIndex = {}
        strong_candidates: dict[str, set[str]] = defaultdict(set)
        strong_candidates_by_org: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        candidate_index: dict[str, set[str]] = defaultdict(set)
        candidate_index_by_org: dict[str, dict[str, set[str]]] = defaultdict(lambda: defaultdict(set))
        members_by_org: dict[str, list[dict[str, Any]]] = {}
        org_payload: list[dict[str, Any]] = []

        for org in orgs:
            members = org_members(api, org)
            members_by_org[org] = members
            for member in members:
                login = str(member.get("login") or member.get("username") or "")
                if not login:
                    continue
                metric = metrics.setdefault(login, blank_metric(member))
                metric["organizations"].add(org)
                for key in strong_identity_keys(login, member.get("email")):
                    strong_candidates[key].add(login)
                    strong_candidates_by_org[org][key].add(login)
                for key in identity_alias_keys(login, member.get("full_name"), member.get("email")):
                    candidate_index[key].add(login)
                    candidate_index_by_org[org][key].add(login)

        # Only typed exact login/email evidence can automatically resolve a
        # contributor identity. Name/local-part/fuzzy evidence stays in the
        # candidate indexes for review and never changes attribution.
        for key, candidates in strong_candidates.items():
            member_index[key] = next(iter(candidates)) if len(candidates) == 1 else set(candidates)
        member_index_by_org: dict[str, IdentityIndex] = {}
        for org, candidates in strong_candidates_by_org.items():
            member_index_by_org[org] = {
                key: next(iter(logins)) if len(logins) == 1 else set(logins)
                for key, logins in candidates.items()
            }

        for org in orgs:
            members = members_by_org[org]

            repos = org_repos(api, org)
            print(f"{org}: {len(members)} members, {len(repos)} repositories", flush=True)
            repo_payload = []
            for repo in repos:
                print(f"   collecting {org}/{repo['name']}", flush=True)
                repo_payload.append(
                    collect_repo(
                        api,
                        org,
                        repo,
                        member_index,
                        metrics,
                        all_branches=not args.default_branch_only,
                        member_index_by_org=member_index_by_org,
                        candidate_index=candidate_index,
                        candidate_index_by_org=candidate_index_by_org,
                        native_history=args.native_history,
                    )
                )
            org_payload.append({"organization": org, "member_count": len(members), "repositories": repo_payload})

        blame_method = None if args.no_blame else (
            "native git blame over SSH" if args.native_blame else "Gitea commit-diff replay"
        )
        blame_results: list[bool] = []
        if not args.no_blame:
            for metric in metrics.values():
                metric["blame_lines"] = 0
                metric["blame_files"] = 0
            if args.native_blame:
                if args.raw_blame is not None:
                    args.raw_blame.parent.mkdir(parents=True, exist_ok=True)
                    args.raw_blame.write_text(
                        "# Raw native git blame output\n"
                        "# Command: git blame --line-porcelain -w -- <file>\n",
                        encoding="utf-8",
                    )
                with tempfile.TemporaryDirectory(prefix="appdev-gitea-native-blame-") as temp:
                    root = Path(temp)
                    for org_record in org_payload:
                        for repo in org_record["repositories"]:
                            print(f"   native blame {repo['organization']}/{repo['name']}", flush=True)
                            blame_results.append(native_blame_repo(
                                repo,
                                member_index,
                                metrics,
                                member_index_by_org,
                                candidate_index,
                                candidate_index_by_org,
                                root,
                                args.raw_blame,
                            ))
            else:
                for org_record in org_payload:
                    for repo in org_record["repositories"]:
                        print(f"   attributing current lines for {repo['organization']}/{repo['name']}", flush=True)
                        blame_results.append(blame_repo(api, repo, metrics))

        if args.no_blame:
            blame_status = "disabled"
        elif not blame_results or all(blame_results):
            blame_status = "complete"
        elif any(blame_results):
            blame_status = "partial"
        else:
            blame_status = "failed"
        if blame_status != "complete":
            for metric in metrics.values():
                metric.setdefault("availability", {}).update(blame_lines=blame_status, blame_files=blame_status)

        rows = [apply_collection_coverage(row, api.coverage) for row in finalize_metrics(metrics)]
        payload = {
            "schema": "gitea.analytics.v3",
            "generated_at": datetime.now(timezone.utc),
            "gitea_url": args.url.rstrip("/"),
            "history_scope": "default branch and all discovered branches" if not args.default_branch_only else "default branch only",
            "commit_stats_scope": (
                "all selected commits; each commit carries explicit stats coverage"
            ),
            "metric_semantics": {
                **METRIC_SEMANTICS,
                "commits": "Git commits whose author identity was resolved to this row in the selected history scope",
                "commits_default_reachable": "Resolved authored commits reachable from a native default branch",
                "commits_branch_only": "Resolved authored commits observed only on non-default native branches; unknown ref membership is not counted",
                "pulls_opened": "Pull requests authored by this identity",
                "pulls_merged": "Pull requests authored by this identity that Gitea reports as merged",
                "pulls_contributed_to": "Distinct pull requests whose commit endpoint contains at least one authored commit for this identity",
                "pulls_merged_contributed_to": "Distinct merged pull requests whose commit endpoint contains at least one authored commit for this identity",
                "pull_commits_authored": "Distinct repo-qualified pull-request commit SHAs authored by this identity",
                "merged_pull_commits_authored": "Distinct repo-qualified commit SHAs authored by this identity in merged pull requests",
                "missingness": "null means the selected evidence was unavailable or incomplete; zero means the relevant endpoint completed and observed none",
            },
            "blame_method": blame_method,
            "blame": {
                "status": blame_status,
                "method": blame_method,
                "requested_repositories": 0 if args.no_blame else len(blame_results),
                "completed_repositories": sum(1 for result in blame_results if result),
            },
            "identity_resolution": {
                "schema": "gitea.identity-resolution.v2",
                "roster_members_are_explicit": True,
                "raw_event_identity_fields": ["login", "name", "email", "committer_identity"],
                "automatic_match_fields": [
                    "exact_gitea_login",
                    "exact_email",
                ],
                "candidate_only_fields": ["name", "email_local_part", "compact_tokens", "substring_similarity"],
                "ambiguity_policy": "keep separate unless an exact typed login or email matches; heuristic aliases remain review candidates",
            },
            "organizations": org_payload,
            "members": rows,
            "api_calls": api.calls,
            "coverage": api.coverage,
            "coverage_summary": {
                "complete": sum(1 for event in api.coverage if event.get("status") == "complete"),
                "partial": sum(1 for event in api.coverage if event.get("status") == "partial"),
                "failed": sum(1 for event in api.coverage if event.get("status") == "failed"),
                "unknown": sum(1 for event in api.coverage if event.get("status") == "unknown"),
            },
            "warnings": api.failures,
        }
        for output in (args.json, args.markdown):
            output.parent.mkdir(parents=True, exist_ok=True)
        args.json.write_text(json.dumps(jsonable(payload), indent=2) + "\n", encoding="utf-8")
        write_markdown(
            args.markdown,
            rows,
            orgs,
            sum(len(o["repositories"]) for o in org_payload),
            api.failures,
            blame_method=blame_method,
            blame_status=blame_status,
        )
        print(f"Wrote {args.json}")
        print(f"Wrote {args.markdown}")
        print(f"API requests: {api.calls}; warnings: {len(api.failures)}")
    finally:
        api.close()


if __name__ == "__main__":
    main()
