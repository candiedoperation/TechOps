"""Pure parsing of ``git blame --line-porcelain`` text. No I/O of any kind.

This module is alone in its own PR because it is the piece legacy got wrong.
`blame_repo` parsed two fields -- ``author`` and ``author-mail`` -- and dropped
the other twelve, so recovering a timestamp later meant re-cloning every
repository. It also inferred success from the absence of an exception, which is
how it reported ``complete`` having attributed nothing.

Being pure is what makes that untestable failure testable: the whole layer is
``str -> list[BlameRecord]``, so a 14MB real capture on disk is a fixture, and
the known counts of that capture are the acceptance criteria.

Grain: one record per blamed line, because that is exactly what
``--line-porcelain`` emits -- a full metadata block per line. Aggregation into
per-commit and per-file rows is PR 4's job, over records that have already been
read correctly.
"""

from __future__ import annotations

import re
from collections.abc import Iterator
from dataclasses import dataclass

# The section header blame_capture writes above each file. The flag list is
# matched loosely on purpose: captures made before -M -C were added say
# `--line-porcelain -w`, and both must keep parsing.
_SECTION_RE = re.compile(
    r"^===== git blame .* -- (?P<org>[^/]+)/(?P<repo>[^:]+):(?P<path>.*) =====$"
)

# `<sha> <line in the original file> <line in the final file> [<lines in group>]`.
# The fourth field appears only on the first line of a run of consecutive lines
# from the same commit, which is what makes it the group size.
_HEADER_RE = re.compile(
    r"^(?P<sha>(?:[0-9a-f]{40}|[0-9a-f]{64})) (?P<orig>\d+) "
    r"(?P<final>\d+)(?: (?P<group>\d+))?$"
)
_REQUIRED_METADATA = frozenset(
    {
        "author",
        "author-mail",
        "author-time",
        "author-tz",
        "committer",
        "committer-mail",
        "committer-time",
        "committer-tz",
        "summary",
        "filename",
    }
)


@dataclass(frozen=True)
class BlameRecord:
    """One blamed line, with every field git emitted about it.

    Field names say what the value is rather than which git flag produced it:
    ``git blame``'s own vocabulary (``filename``, ``previous``, ``boundary``) is
    only legible next to the man page, and these records are read by people
    writing SQL against the tables in PR 4. The git name each one came from is
    on the line beside it.

    The line's own text is deliberately absent. It is the one thing in the
    capture that is content rather than provenance, it is what makes the capture
    14MB, and no column in the schema holds it.
    """

    # Where the line lives now.
    organization: str                      # from the capture's section header
    repository: str                        # from the capture's section header
    blamed_file_path: str                  # the file being blamed in this run
    line_number_in_file: int               # blame header, final line number

    # Which commit it survives from.
    commit_sha: str                        # blame header, sha
    commit_summary: str                    # `summary`
    consecutive_line_count: int | None      # blame header, size of this run of lines
    line_number_at_origin: int             # blame header, line number in that commit

    # Who wrote it, and when.
    author_name: str                       # `author`
    author_email: str                      # `author-mail`
    authored_at_epoch: int | None          # `author-time`, seconds since epoch
    author_utc_offset: str                 # `author-tz`, e.g. -0400

    # Who applied it, and when. Differs from the author on a rebase or a merge.
    committer_name: str                    # `committer`
    committer_email: str                   # `committer-mail`
    committed_at_epoch: int | None         # `committer-time`, seconds since epoch
    committer_utc_offset: str              # `committer-tz`

    # Where the line came from before it lived here.
    origin_file_path: str                  # `filename`; differs under -M/-C
    previous_commit_sha: str | None        # `previous`, sha half
    previous_file_path: str | None         # `previous`, path half

    # Whether blame ran out of history rather than finding an earlier author.
    reaches_history_boundary: bool         # `boundary`

    @property
    def moved_between_files(self) -> bool:
        """True when -M/-C traced this line back to a different file."""

        return self.origin_file_path != self.blamed_file_path


class BlameParseError(ValueError):
    """The capture is not blame porcelain, or is truncated mid-block."""


def parse_blame_capture(text: str) -> list[BlameRecord]:
    """Parse a whole capture file into one record per blamed line."""

    return list(_iter_blame_records(text))


def _iter_blame_records(text: str) -> Iterator[BlameRecord]:
    """Walk the porcelain blocks, yielding one record per blamed line."""

    section: tuple[str, str, str] | None = None
    seen_sections: set[tuple[str, str, str]] = set()
    expected_line_number = 1
    header: re.Match[str] | None = None
    fields: dict[str, str] = {}
    boundary = False

    for raw in text.splitlines():
        matched_section = _SECTION_RE.match(raw)
        if matched_section:
            if header is not None:
                raise BlameParseError(
                    f"capture ends mid-block at {matched_section.group('path')}"
                )
            section = (
                matched_section.group("org"),
                matched_section.group("repo"),
                matched_section.group("path"),
            )
            if not section[2]:
                raise BlameParseError("capture section has an empty file path")
            if section in seen_sections:
                raise BlameParseError(
                    f"capture contains duplicate sections for {section[0]}/{section[1]}:{section[2]}"
                )
            seen_sections.add(section)
            expected_line_number = 1
            continue

        if header is None:
            matched_header = _HEADER_RE.match(raw)
            if matched_header:
                if section is None:
                    raise BlameParseError(
                        "blame block before any `=====` section header -- the capture "
                        "is missing the header that names the repository and path."
                    )
                header = matched_header
                fields = {}
                boundary = False
            # Anything else out here is the `#` preamble, or a blank line.
            continue

        if raw.startswith("\t"):
            # The line's own text closes the block. Its content is discarded;
            # everything above it has already been collected.
            record = _build(section, header, fields, boundary)
            if record.line_number_in_file != expected_line_number:
                raise BlameParseError(
                    f"expected final line {expected_line_number} in "
                    f"{record.organization}/{record.repository}:{record.blamed_file_path}, "
                    f"received {record.line_number_in_file}"
                )
            expected_line_number += 1
            yield record
            header = None
            continue

        key, _, value = raw.partition(" ")
        if key == "boundary":
            boundary = True
        else:
            fields[key] = value

    if header is not None:
        raise BlameParseError("capture ends mid-block -- the last line has no content line")


def _build(
    section: tuple[str, str, str] | None,
    header: re.Match[str],
    fields: dict[str, str],
    boundary: bool,
) -> BlameRecord:
    org, repo, path = section if section else ("", "", "")
    missing = sorted(_REQUIRED_METADATA - fields.keys())
    if missing:
        raise BlameParseError(
            f"blame block for {org}/{repo}:{path} omitted metadata: {', '.join(missing)}"
        )

    original_line_number = int(header.group("orig"))
    final_line_number = int(header.group("final"))
    if original_line_number < 1 or final_line_number < 1:
        raise BlameParseError("blame line numbers must be positive")

    authored_at = _as_int(fields["author-time"])
    committed_at = _as_int(fields["committer-time"])
    if authored_at is None or committed_at is None:
        raise BlameParseError("blame author-time and committer-time must be integers")

    for field_name in ("author-tz", "committer-tz"):
        if not re.fullmatch(r"[+-]\d{4}", fields[field_name]):
            raise BlameParseError(f"blame {field_name} must be a signed four-digit offset")

    previous_sha, previous_path = _split_previous(fields.get("previous"))
    if "previous" in fields and (
        not previous_sha
        or not re.fullmatch(r"(?:[0-9a-f]{40}|[0-9a-f]{64})", previous_sha)
        or not previous_path
    ):
        raise BlameParseError("blame previous metadata must contain a commit SHA and file path")
    group = header.group("group")
    if group is not None and int(group) < 1:
        raise BlameParseError("blame consecutive-line count must be positive")

    return BlameRecord(
        organization=org,
        repository=repo,
        blamed_file_path=path,
        line_number_in_file=final_line_number,
        commit_sha=header.group("sha"),
        commit_summary=fields.get("summary", ""),
        consecutive_line_count=int(group) if group else None,
        line_number_at_origin=original_line_number,
        author_name=fields.get("author", ""),
        author_email=_strip_angle_brackets(fields.get("author-mail", "")),
        authored_at_epoch=authored_at,
        author_utc_offset=fields.get("author-tz", ""),
        committer_name=fields.get("committer", ""),
        committer_email=_strip_angle_brackets(fields.get("committer-mail", "")),
        committed_at_epoch=committed_at,
        committer_utc_offset=fields.get("committer-tz", ""),
        # `filename` is always present in porcelain output; falling back to the
        # blamed path keeps a malformed block from inventing an empty source.
        origin_file_path=fields.get("filename", path),
        previous_commit_sha=previous_sha,
        previous_file_path=previous_path,
        reaches_history_boundary=boundary,
    )


def _split_previous(value: str | None) -> tuple[str | None, str | None]:
    """`previous <sha> <path>`; the path may contain spaces, the sha may not."""

    if not value:
        return None, None
    sha, _, path = value.partition(" ")
    return sha or None, path or None


def _strip_angle_brackets(value: str) -> str:
    return value[1:-1] if value.startswith("<") and value.endswith(">") else value


def _as_int(value: str | None) -> int | None:
    try:
        return int(value) if value else None
    except ValueError:
        return None
