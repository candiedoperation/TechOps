"""L2 capture: clone the repository and write raw ``git blame`` text to disk.

The only asset in the graph that touches the network or the filesystem, which
is the point of the cut: everything slow or flaky lives here, and everything
downstream re-runs against the text this produced without cloning anything.

Nothing is interpreted here. The text is stored exactly as git emitted it --
all 14 porcelain fields, every tracked file, no extension allowlist -- because
the one thing that cannot be recovered later is a field that was never written
down. Parsing is PR 3's job, and it is pure.
"""

from dataclasses import dataclass, field
from pathlib import Path

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from dagster import AssetExecutionContext, Failure, MetadataValue, asset

from ..metadata import table_schema_from
from ..resources import BLAME_FLAGS, GitWorkspace, Repository

# The section header written above each file's blame output. It carries the
# org, repo and path, so the capture stays self-describing once it is detached
# from the run that made it -- and matches the shape of the existing
# data/amazon-leo-git-blame.txt capture, which PR 3's parser reads as its
# acceptance fixture.
_FLAG_TEXT = " ".join(BLAME_FLAGS)
_PREAMBLE = f"# Raw native git blame output\n# Command: git blame {_FLAG_TEXT} -- <file>\n"

# git's own binary heuristic: a NUL byte inside the first 8000 bytes. Blaming a
# binary file yields no attributable lines, and a capture full of empty
# sections would make PR 3's records_parse_completely check meaningless.
_BINARY_SNIFF_BYTES = 8000

# Failed paths are kept for the run's metadata, not for analysis. A repo where
# everything fails should be read off the count, not off a 10,000-line list.
_MAX_REPORTED_FAILURES = 20


@dataclass(frozen=True)
class BlameCapture:
    """A handle on raw blame text that is already on disk.

    Counts travel with the handle so a partial capture is visible as a number
    downstream rather than as a quietly shorter file. The legacy run reported
    ``complete`` while capturing nothing at all; a caller of this cannot make
    that mistake without ignoring a field.
    """

    org: str
    repo: str
    default_branch: str
    path: Path
    files_tracked: int
    files_captured: int
    files_skipped_binary: int
    files_failed: int
    bytes_written: int
    failed_paths: tuple[str, ...] = field(default_factory=tuple)

    @property
    def slug(self) -> str:
        return f"{self.org}/{self.repo}"


CAPTURE_SCHEMA = table_schema_from(
    BlameCapture,
    {
        "org": ("string", "Gitea organization the capture is of."),
        "repo": ("string", "Repository the capture is of."),
        "default_branch": ("string", "Branch that was cloned and blamed."),
        "path": ("path", "File on disk holding the raw blame text."),
        "files_tracked": ("int", "Files git tracks in the clone, before any skipping."),
        "files_captured": ("int", "Files that produced blame output and reached the capture."),
        "files_skipped_binary": ("int", "Files skipped as binary -- no lines to attribute."),
        "files_failed": ("int", "Files git could not blame. Counted, never silently dropped."),
        "bytes_written": ("int", "Size of the capture file."),
        "failed_paths": ("list[string]", "First few files that failed, for diagnosis."),
    },
)


@asset(
    group_name="l2_capture",
    kinds={"git"},
    description=(
        "Raw `git blame --line-porcelain -w -M -C` text for every tracked file, "
        "written to disk so later layers re-run without re-cloning. Nothing is "
        "interpreted here -- no extension filter, all 14 fields kept."
    ),
    metadata={
        "dagster/column_schema": CAPTURE_SCHEMA,
        "blame_command": "git blame --line-porcelain -w -M -C",
        "grain": "one capture file per repository per run",
    },
)
def blame_capture(
    context: AssetExecutionContext,
    gitea_repository: Repository,
    workspace: GitWorkspace,
) -> BlameCapture:
    if gitea_repository.empty:
        # Gitea already knows there is nothing here. Saying so now costs one
        # comparison; finding out by cloning costs a network round trip and
        # surfaces as `git clone --branch` failing on a ref that does not
        # exist, which reads like a broken pipeline rather than an empty repo.
        raise Failure(
            description=(
                f"{gitea_repository.slug} is empty -- Gitea reports no commits on "
                f"{gitea_repository.default_branch}. There is nothing to blame."
            )
        )

    destination = workspace.capture_path(context.run.run_id, gitea_repository)

    tracked = 0
    captured = 0
    skipped_binary = 0
    failed: list[str] = []

    with workspace.clone(gitea_repository) as clone:
        paths = workspace.list_tracked_files(clone)
        tracked = len(paths)
        context.log.info("%s: %d tracked files", gitea_repository.slug, tracked)

        with destination.open("w", encoding="utf-8") as handle:
            handle.write(_PREAMBLE)

            for path in paths:
                if _is_binary(clone / path):
                    skipped_binary += 1
                    continue

                blamed = workspace.blame_file(clone, path)
                if blamed is None:
                    failed.append(path)
                    continue
                if not blamed.strip():
                    # An empty file blames to nothing. Writing an empty section
                    # would trip PR 3's "every file yields records" check for a
                    # reason that is not a failure.
                    continue

                handle.write(f"\n===== git blame {_FLAG_TEXT} -- {gitea_repository.slug}:{path} =====\n")
                handle.write(blamed)
                captured += 1

    capture = BlameCapture(
        org=gitea_repository.org,
        repo=gitea_repository.name,
        default_branch=gitea_repository.default_branch,
        path=destination,
        files_tracked=tracked,
        files_captured=captured,
        files_skipped_binary=skipped_binary,
        files_failed=len(failed),
        bytes_written=destination.stat().st_size,
        failed_paths=tuple(failed[:_MAX_REPORTED_FAILURES]),
    )

    if failed:
        context.log.warning(
            "%s: %d of %d files could not be blamed", capture.slug, len(failed), tracked
        )

    context.add_output_metadata(
        {
            "repository": MetadataValue.text(capture.slug),
            "capture_path": MetadataValue.path(str(capture.path)),
            "files_tracked": MetadataValue.int(capture.files_tracked),
            "files_captured": MetadataValue.int(capture.files_captured),
            "files_skipped_binary": MetadataValue.int(capture.files_skipped_binary),
            "files_failed": MetadataValue.int(capture.files_failed),
            "bytes_written": MetadataValue.int(capture.bytes_written),
            "failed_paths": MetadataValue.text(
                ", ".join(capture.failed_paths) if capture.failed_paths else "none"
            ),
        }
    )
    return capture


def _is_binary(path: Path) -> bool:
    """Git's heuristic: a NUL byte near the start means binary.

    A path that cannot be read at all -- a broken symlink, a permission
    problem -- counts as binary too: either way there are no lines to attribute,
    and the alternative is an exception that loses the whole repository.
    """

    try:
        with path.open("rb") as handle:
            return b"\0" in handle.read(_BINARY_SNIFF_BYTES)
    except OSError:
        return True
