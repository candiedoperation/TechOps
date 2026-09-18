"""Shared resources. None of these is an asset.

A clone is an ephemeral working directory and a connection is a handle, not a
data artifact, so neither belongs in the asset graph -- keeping them here is
what lets assets return records instead of tempdir paths.

``GiteaClient`` and ``GitWorkspace`` are implemented here as of PR 2;
``PostgresResource`` is still configuration surface only and gains behaviour in
PR 4.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from uuid import uuid4

import httpx
from dagster import ConfigurableResource

from .config import PipelineConfigError, PipelineSettings, get_pipeline_settings

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


class GiteaError(RuntimeError):
    """Gitea answered, but not with what was asked for."""


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
        try:
            yield destination
        finally:
            if not self.keep_clones:
                shutil.rmtree(destination, ignore_errors=True)

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


class PostgresResource(ConfigurableResource):
    """Connection factory for the ``horizon`` schema.

    A new schema in the existing database: the legacy ``gitea_analytics`` tables
    stay untouched as the correctness baseline the new numbers are read against.

    Configuration surface only until PR 4, which is the first PR that writes.
    """

    database_url: str | None = None
    schema_name: str = "horizon"


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
        "workspace": GitWorkspace(),
        "postgres": PostgresResource(database_url=resolved.database_url),
    }
