"""Bounded, token-budgeted Gitea code evidence for the lazy LLM weekly signal.

Fetches only what a week's judgment needs: cheap commit metadata first
(sha, message, per-commit total stats, touched filenames -- no diff body),
then escalates to a raw unified diff only for commits substantial enough to
justify one, within the byte/hunk caps in ``DiffLimits``. This is the
opposite of ``GiteaRepoActivityAdapter._sync_repo``, which unconditionally
walks every PR's full review history on every call -- that unbounded cost is
what made a bulk multi-week backfill time out. This reader never touches PR
review history at all, only commits and their diffs, and only for one ISO
week at a time.

Synchronous (``httpx.Client``, matching ``GiteaRepoActivityAdapter``) --
callers must wrap it in ``anyio.to_thread.run_sync``.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta, timezone
from typing import Any
from urllib.parse import quote

from .ingestion import DEFAULT_MAX_PAGES, DEFAULT_PAGE_SIZE, _HttpxAdapter, _iso, _extract_page, _header_has_more

# Files that never carry judgeable signal: lockfiles, vendored/build output,
# binaries and media. Filtered before anything counts toward a tier or a
# byte budget -- a lockfile bump can dwarf real code changes in line count.
_NOISE_PATH_PATTERNS = tuple(
    re.compile(pattern, re.IGNORECASE)
    for pattern in (
        r"(^|/)package-lock\.json$",
        r"(^|/)yarn\.lock$",
        r"(^|/)poetry\.lock$",
        r"(^|/)pnpm-lock\.yaml$",
        r"\.sum$",
        r"(^|/)node_modules/",
        r"(^|/)dist/",
        r"(^|/)build/",
        r"(^|/)\.next/",
        r"(^|/)vendor/",
        r"\.min\.(js|css)$",
        r"\.map$",
        r"\.(png|jpe?g|gif|svg|pdf|zip|ico|woff2?|ttf|eot)$",
    )
)

_CHORE_MESSAGE_RE = re.compile(r"^(chore|bump|deps?|merge|revert|format|lint|style)\b", re.IGNORECASE)
_DECLARATION_RE = re.compile(r"^\+\s*(def|class|function|const|export|fn|type|interface|public)\b")
_DIFF_FILE_HEADER_RE = re.compile(r"^diff --git a/(.+) b/(.+)$")
_HUNK_HEADER_RE = re.compile(r"^@@ .*@@")


def _is_noise_path(path: str) -> bool:
    return any(pattern.search(path) for pattern in _NOISE_PATH_PATTERNS)


@dataclass(frozen=True)
class DiffLimits:
    """Caps that keep one project-week's evidence pull and prompt small."""

    max_repos: int = 5
    max_commits_per_repo: int = 15
    max_commits_total: int = 30
    max_bytes_per_commit: int = 20_000
    max_total_diff_bytes: int = 60_000
    max_hunks_per_file: int = 6
    max_files_per_commit: int = 20
    # Tier-1 (metadata-only) threshold: at or under all three -> no diff fetch at all.
    tier1_max_commits: int = 5
    tier1_max_files: int = 10
    tier1_max_lines: int = 150
    # /commits (and this reader) intentionally track the default branch
    # only, by product decision -- unmerged feature-branch work is not
    # counted until it lands on main.
    # Cumulative-progress "shallow layer" bounds (history_metadata): commit
    # LIST pages only, never a per-commit stat/diff call -- that restraint
    # is what keeps a metadata sweep over months of history cheap.
    max_history_pages_per_repo: int = 20
    max_history_subject_samples: int = 60


DEFAULT_LIMITS = DiffLimits()


@dataclass
class CommitFact:
    sha: str
    repo_slug: str
    subject: str
    committed_at: datetime | None
    additions: int
    deletions: int
    files: list[str]
    noise_files: list[str]
    is_noise_only: bool
    is_chore_like: bool
    # True when the per-commit stat call failed, so additions/deletions/files
    # are unknown rather than known-empty. Such a commit is kept out of the
    # diff budget (is_noise_only), but callers must NOT read the resulting
    # empty week as "nothing happened" -- see week_evidence's fetch_errors.
    stat_unavailable: bool = False

    @property
    def real_files(self) -> list[str]:
        return [path for path in self.files if path not in self.noise_files]


@dataclass
class RepoCodeEvidence:
    repo_slug: str
    commits: list[CommitFact] = field(default_factory=list)
    diffs: dict[str, str] = field(default_factory=dict)  # sha -> selected/truncated diff text (tier 2 only)
    truncation_notes: list[str] = field(default_factory=list)
    fetch_errors: list[str] = field(default_factory=list)


@dataclass
class WeekCodeEvidence:
    project_id: str
    week_start: date
    week_end: date
    repos: list[RepoCodeEvidence]
    tier: str  # "tier0" | "tier1" | "tier2"

    @property
    def all_commits(self) -> list[CommitFact]:
        return [commit for repo in self.repos for commit in repo.commits]

    @property
    def non_noise_commits(self) -> list[CommitFact]:
        return [commit for commit in self.all_commits if not commit.is_noise_only]

    @property
    def total_fetch_errors(self) -> int:
        return sum(len(repo.fetch_errors) for repo in self.repos)


@dataclass
class HistoryMetadata:
    """A cheap, metadata-only sweep over a (possibly long) date range.

    Deliberately shallow: total commit counts per ISO week and a bounded
    sample of commit subject lines, built from the commit LIST endpoint
    only. No per-commit stat or diff fetch, so cost is a small, fixed
    number of paginated requests regardless of how much history the range
    covers -- this is what keeps a cumulative-progress "shallow layer"
    independent of history length. Noise (lockfiles etc.) is NOT filtered
    here since that requires a per-commit file list (a stat call); counts
    are raw commit volume, and the synthesis prompt is told so.
    """

    weeks_counts: dict[date, int] = field(default_factory=dict)  # ISO week_start -> commit count
    subject_samples: list[dict[str, Any]] = field(default_factory=list)  # bounded: {repo_slug, sha, subject, week_start}
    repos_covered: list[str] = field(default_factory=list)
    truncated: bool = False
    fetch_errors: list[str] = field(default_factory=list)


def _parse_gitea_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    text = str(value).replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _split_diff_into_files(diff_text: str) -> list[tuple[str, str]]:
    """Split a multi-file unified diff into ``[(path, block_text), ...]``."""

    lines = diff_text.splitlines(keepends=True)
    blocks: list[tuple[str, list[str]]] = []
    current_path: str | None = None
    current_lines: list[str] = []
    for line in lines:
        match = _DIFF_FILE_HEADER_RE.match(line.rstrip("\n"))
        if match:
            if current_path is not None:
                blocks.append((current_path, current_lines))
            current_path = match.group(2)
            current_lines = [line]
        elif current_path is not None:
            current_lines.append(line)
    if current_path is not None:
        blocks.append((current_path, current_lines))
    return [(path, "".join(lines_)) for path, lines_ in blocks]


def _truncate_file_block(path: str, block: str, *, limits: DiffLimits) -> str:
    """Cap one file's diff block to at most ``max_hunks_per_file`` whole hunks."""

    lines = block.splitlines(keepends=True)
    changed_lines = sum(
        1
        for line in lines
        if (line.startswith("+") or line.startswith("-"))
        and not line.startswith("+++")
        and not line.startswith("---")
    )
    if changed_lines < 5:
        return block
    if changed_lines > 400:
        declarations = [line.strip() for line in lines if _DECLARATION_RE.match(line)]
        header_end = next((i for i, line in enumerate(lines) if _HUNK_HEADER_RE.match(line)), len(lines))
        preamble = "".join(lines[:header_end])
        decl_text = "\n".join(f"  {line}" for line in declarations[:20]) or "  (no top-level declarations found)"
        return (
            f"{preamble}[TRUNCATED: {changed_lines} changed lines, too large to include in full]\n"
            f"[declarations added in this file]\n{decl_text}\n"
        )
    hunk_starts = [i for i, line in enumerate(lines) if _HUNK_HEADER_RE.match(line)]
    if len(hunk_starts) <= limits.max_hunks_per_file:
        return block
    cutoff = hunk_starts[limits.max_hunks_per_file]
    omitted = len(hunk_starts) - limits.max_hunks_per_file
    omitted_bytes = len("".join(lines[cutoff:]).encode("utf-8"))
    kept = "".join(lines[:cutoff])
    return f"{kept}[TRUNCATED: {omitted} hunks omitted, {omitted_bytes} bytes]\n"


def _select_and_truncate_diff(diff_text: str, *, limits: DiffLimits) -> tuple[str, list[str]]:
    """Apply the noise filter + per-file truncation to one commit's diff."""

    notes: list[str] = []
    files = _split_diff_into_files(diff_text)
    if not files:
        selected = diff_text.encode("utf-8")[:limits.max_bytes_per_commit].decode("utf-8", errors="ignore")
        if selected != diff_text:
            notes.append("unparsed diff truncated to per-commit byte cap")
        return selected, notes
    parts: list[str] = []
    real_files = [(path, block) for path, block in files if not _is_noise_path(path)]
    if len(real_files) > limits.max_files_per_commit:
        notes.append("diff files truncated to per-commit file cap")
    allowed = {path for path, _ in real_files[:limits.max_files_per_commit]}
    for path, block in files:
        if _is_noise_path(path):
            header_line = block.splitlines(keepends=True)[0] if block else f"diff --git a/{path} b/{path}\n"
            parts.append(f"{header_line}[SKIPPED: generated/binary/lockfile]\n")
            notes.append(f"{path}: skipped (noise)")
            continue
        if path not in allowed:
            continue
        selected = _truncate_file_block(path, block, limits=limits)
        if selected != block:
            notes.append(f"{path}: diff hunks truncated")
        parts.append(selected)
    result = "".join(parts)
    if len(result.encode("utf-8")) > limits.max_bytes_per_commit:
        result = result.encode("utf-8")[: limits.max_bytes_per_commit].decode("utf-8", errors="ignore")
        notes.append("commit diff truncated to per-commit byte cap")
    return result, notes


class GiteaCodeEvidenceReader(_HttpxAdapter):
    """Pulls one ISO week's commit evidence for a project's repos, tiered by cost."""

    def __init__(
        self,
        *,
        base_url: str | None,
        token: str | None,
        organization: str | None,
        client: Any = None,
        client_factory: Any = None,
        limits: DiffLimits = DEFAULT_LIMITS,
        page_size: int = DEFAULT_PAGE_SIZE,
        max_pages: int = DEFAULT_MAX_PAGES,
        timeout: float = 30.0,
    ) -> None:
        super().__init__(base_url=base_url, token=token, client=client, client_factory=client_factory, timeout=timeout)
        self.organization = organization
        self.limits = limits
        self.page_size = page_size
        self.max_pages = max_pages

    def _repo_path(self, repo_slug: str, suffix: str) -> str:
        if not self.organization:
            raise ValueError("Gitea organization is not configured")
        return f"/api/v1/repos/{quote(self.organization, safe='')}/{quote(repo_slug, safe='')}/{suffix.lstrip('/')}"

    def commits_in_window(self, repo_slug: str, *, since: datetime, until: datetime) -> list[Mapping[str, Any]]:
        # Default branch only, by design -- see DiffLimits' docstring note.
        return self.pages(
            self._repo_path(repo_slug, "commits"),
            params={"since": _iso(since), "until": _iso(until)},
            page_size=self.page_size,
            max_pages=self.max_pages,
        )

    def _history_pages(self, repo_slug: str, *, since: datetime, until: datetime) -> tuple[list[Mapping[str, Any]], bool]:
        """Retain fetched pages when the history budget is reached."""
        collected: list[Mapping[str, Any]] = []
        path = self._repo_path(repo_slug, "commits")
        next_url = None
        for page in range(1, self.limits.max_history_pages_per_repo + 1):
            payload, headers = self._get_json_with_headers(
                next_url or path,
                None if next_url else {"since": _iso(since), "until": _iso(until), "page": page, "limit": self.page_size},
            )
            items, next_url, has_more = _extract_page(payload)
            collected.extend(items)
            if not items:
                return collected, False
            more_header = headers.get("x-hasmore", headers.get("X-HasMore"))
            more = bool(next_url or has_more or _header_has_more(headers))
            if not more and (str(more_header).lower() == "false" or len(items) < self.page_size):
                return collected, False
        return collected, True

    def history_metadata(self, repo_slugs: Sequence[str], *, start: date, end: date) -> HistoryMetadata:
        """Cheap per-week commit counts + subject sample over a date range.

        Uses only the commit LIST endpoint (paginated, capped at
        ``max_history_pages_per_repo`` pages/repo) -- never ``commit_stat``
        or ``commit_diff``. That's the whole point: cost here is a small,
        fixed number of requests independent of how long ``[start, end]``
        is, which is what makes a cumulative-progress "shallow layer" over
        months of history cheap.
        """
        since = datetime.combine(start, datetime.min.time(), tzinfo=timezone.utc)
        until = datetime.combine(end, datetime.max.time(), tzinfo=timezone.utc)
        result = HistoryMetadata(repos_covered=list(repo_slugs)[: self.limits.max_repos],
                                 truncated=len(repo_slugs) > self.limits.max_repos)
        for repo_slug in result.repos_covered:
            try:
                raw_commits, truncated = self._history_pages(repo_slug, since=since, until=until)
                result.truncated |= truncated
            except Exception:
                result.fetch_errors.append(f"{repo_slug}: history fetch failed")
                continue
            if len(raw_commits) >= self.page_size * self.limits.max_history_pages_per_repo:
                result.truncated = True
            for raw in raw_commits:
                when = _parse_gitea_datetime((raw.get("commit") or {}).get("committer", {}).get("date"))
                if when is None or not (since <= when <= until):
                    continue
                week_start = when.date() - timedelta(days=when.date().weekday())
                result.weeks_counts[week_start] = result.weeks_counts.get(week_start, 0) + 1
                if len(result.subject_samples) < self.limits.max_history_subject_samples:
                    message = str((raw.get("commit") or {}).get("message", "")).strip()
                    subject = message.splitlines()[0] if message else ""
                    result.subject_samples.append({
                        "repo_slug": repo_slug,
                        "sha": str(raw.get("sha", ""))[:12],
                        "subject": subject,
                        "week_start": week_start.isoformat(),
                    })
        return result

    def commit_stat(self, repo_slug: str, sha: str) -> Mapping[str, Any] | None:
        try:
            return self.get_json(self._repo_path(repo_slug, f"git/commits/{quote(sha, safe='')}"), {"stat": "true", "files": "true"})
        except Exception:
            return None

    def commit_diff(self, repo_slug: str, sha: str) -> str | None:
        try:
            return self.get_text(self._repo_path(repo_slug, f"git/commits/{quote(sha, safe='')}.diff"))
        except Exception:
            return None

    def _commit_fact(self, repo_slug: str, commit: Mapping[str, Any]) -> CommitFact | None:
        sha = commit.get("sha")
        if not sha:
            return None
        message = str((commit.get("commit") or {}).get("message", "")).strip()
        subject = message.splitlines()[0] if message else "(no message)"
        committed_at = _parse_gitea_datetime((commit.get("commit") or {}).get("committer", {}).get("date"))
        meta = self.commit_stat(repo_slug, sha)
        if not isinstance(meta, Mapping) or "files" not in meta or "stats" not in meta:
            return CommitFact(
                sha=sha, repo_slug=repo_slug, subject=subject, committed_at=committed_at,
                additions=0, deletions=0, files=[], noise_files=[], is_noise_only=True,
                is_chore_like=bool(_CHORE_MESSAGE_RE.match(subject)),
                stat_unavailable=True,
            )
        stats = meta.get("stats") or {}
        files_meta = meta.get("files") or []
        # Merge commits can contain conflict-resolution changes. Judge their
        # actual file list, not the number of parents.
        files = [str(item.get("filename")) for item in files_meta if item.get("filename")]
        noise_files = [path for path in files if _is_noise_path(path)]
        real_files = [path for path in files if path not in noise_files]
        is_noise_only = not real_files
        return CommitFact(
            sha=sha, repo_slug=repo_slug, subject=subject, committed_at=committed_at,
            additions=int(stats.get("additions") or 0), deletions=int(stats.get("deletions") or 0),
            files=files, noise_files=noise_files, is_noise_only=is_noise_only,
            is_chore_like=bool(_CHORE_MESSAGE_RE.match(subject)),
        )

    def week_evidence(self, *, project_id: str, repo_slugs: Sequence[str], week_start: date, week_end: date) -> WeekCodeEvidence:
        since = datetime.combine(week_start, datetime.min.time(), tzinfo=timezone.utc)
        until = datetime.combine(week_end, datetime.max.time(), tzinfo=timezone.utc)
        repos: list[RepoCodeEvidence] = []
        remaining = self.limits.max_commits_total
        for repo_slug in list(repo_slugs)[: self.limits.max_repos]:
            evidence = RepoCodeEvidence(repo_slug=repo_slug)
            try:
                raw_commits = self.commits_in_window(repo_slug, since=since, until=until)
            except Exception:
                evidence.fetch_errors.append("commit list fetch failed")
                repos.append(evidence)
                continue
            # Gitea's server-side since/until on /commits is not reliably
            # restrictive on its own (confirmed against the real instance --
            # commits well outside the requested week came back), so this
            # mirrors GiteaRepoActivityAdapter's own client-side re-check
            # (ingestion.py's per-commit since/until filter) rather than
            # trusting the raw response.
            in_window_commits = [
                raw for raw in raw_commits
                if (when := _parse_gitea_datetime((raw.get("commit") or {}).get("committer", {}).get("date"))) is not None
                and since <= when <= until
            ]
            selected_commits = in_window_commits[:min(self.limits.max_commits_per_repo, remaining)]
            remaining -= len(selected_commits)
            if len(selected_commits) < len(in_window_commits):
                evidence.truncation_notes.append(f"{len(selected_commits)} of {len(in_window_commits)} commits inspected (metadata cap)")
            if len(repo_slugs) > self.limits.max_repos:
                evidence.truncation_notes.append("mapped repositories omitted by repository cap")
            for raw in selected_commits:
                fact = self._commit_fact(repo_slug, raw)
                if fact is not None:
                    evidence.commits.append(fact)
                    if fact.stat_unavailable:
                        # Recorded, not swallowed: a stat outage otherwise
                        # empties non_noise_commits and reads identically to
                        # a genuinely quiet week.
                        evidence.fetch_errors.append(f"{fact.sha}: commit metadata fetch failed")
            repos.append(evidence)

        all_non_noise = [commit for repo in repos for commit in repo.commits if not commit.is_noise_only]
        total_files = len({(commit.repo_slug, path) for commit in all_non_noise for path in commit.real_files})
        total_lines = sum(commit.additions + commit.deletions for commit in all_non_noise)

        if not all_non_noise:
            return WeekCodeEvidence(project_id=project_id, week_start=week_start, week_end=week_end, repos=repos, tier="tier0")

        if (
            len(all_non_noise) <= self.limits.tier1_max_commits
            and total_files <= self.limits.tier1_max_files
            and total_lines <= self.limits.tier1_max_lines
        ):
            return WeekCodeEvidence(project_id=project_id, week_start=week_start, week_end=week_end, repos=repos, tier="tier1")

        # Tier 2: fetch diffs for the largest-by-changed-lines commits first,
        # within the global byte budget, skipping chore-like commits whose
        # touched files are all small.
        candidates = sorted(
            (commit for commit in all_non_noise if not commit.is_noise_only),
            key=lambda commit: (-(commit.additions + commit.deletions), commit.sha),
        )[: self.limits.max_commits_total]
        budget = self.limits.max_total_diff_bytes
        for commit in candidates:
            if budget <= 0:
                break
            diff_text = self.commit_diff(commit.repo_slug, commit.sha)
            repo_evidence = next(r for r in repos if r.repo_slug == commit.repo_slug)
            if not diff_text or not diff_text.strip():
                repo_evidence.fetch_errors.append(f"{commit.sha}: diff fetch failed")
                continue
            selected, notes = _select_and_truncate_diff(diff_text, limits=self.limits)
            selected_bytes = len(selected.encode("utf-8"))
            if selected_bytes > budget:
                selected = selected.encode("utf-8")[:budget].decode("utf-8", errors="ignore")
                notes.append("truncated to remaining project-week diff budget")
            repo_evidence.diffs[commit.sha] = selected
            repo_evidence.truncation_notes.extend(notes)
            budget -= selected_bytes

        included = sum(len(repo.diffs) for repo in repos)
        for repo_evidence in repos:
            if repo_evidence.commits:
                repo_evidence.truncation_notes.insert(
                    0, f"{included} of {len(candidates)} substantive commits selected for diff review across the project"
                )
                break
        return WeekCodeEvidence(project_id=project_id, week_start=week_start, week_end=week_end, repos=repos, tier="tier2")
