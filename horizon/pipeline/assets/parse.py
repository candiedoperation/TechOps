"""L3 parse: raw blame text into records. Pure, apart from reading the capture.

The parsing itself lives in ``pipeline.blame_parser`` and touches nothing. This
asset is only the shell around it: read the file the capture layer wrote, hand
the text over, attach counts. That separation is the point -- the logic legacy
got wrong is reachable from a test with a string and no repository.
"""

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from dataclasses import fields as dataclass_fields

from dagster import AssetExecutionContext, Failure, MetadataValue, TableRecord, asset

from ..blame_parser import BlameRecord, parse_blame_capture
from ..metadata import table_schema_from
from .capture import BlameCapture


# What each column means, in the words someone writing SQL against PR 4's tables
# would use, plus the git blame field it came from. Dagster renders this on the
# asset, so the meaning of a column is one click away rather than a man page away.
_COLUMN_NOTES: dict[str, tuple[str, str]] = {
    "organization": ("string", "Gitea organization that owns the repository."),
    "repository": ("string", "Repository the line was blamed in."),
    "blamed_file_path": ("string", "Path of the file as it exists now."),
    "line_number_in_file": ("int", "Line number in the file as it exists now."),
    "commit_sha": ("string", "Commit this line still survives from."),
    "commit_summary": ("string", "Subject line of that commit (git `summary`)."),
    "consecutive_line_count": (
        "int?",
        "How many consecutive lines came from this commit; set on the first of the run only.",
    ),
    "line_number_at_origin": ("int", "Line number this line had in the originating commit."),
    "author_name": ("string", "Who wrote the line (git `author`)."),
    "author_email": ("string", "Email they wrote it under (git `author-mail`)."),
    "authored_at_epoch": ("int?", "When it was written, seconds since the epoch."),
    "author_utc_offset": ("string", "UTC offset the author was in, e.g. -0400."),
    "committer_name": (
        "string",
        "Who applied the commit -- differs from the author after a rebase or merge.",
    ),
    "committer_email": ("string", "Email of the committer (git `committer-mail`)."),
    "committed_at_epoch": ("int?", "When it was committed, seconds since the epoch."),
    "committer_utc_offset": ("string", "UTC offset the committer was in."),
    "origin_file_path": (
        "string",
        "File the line actually came from; differs from blamed_file_path when -M/-C followed a move.",
    ),
    "previous_commit_sha": ("string?", "Commit the line lived in before this one (git `previous`)."),
    "previous_file_path": ("string?", "Path it had in that earlier commit."),
    "reaches_history_boundary": (
        "bool",
        "Blame ran out of history here rather than finding an earlier author (git `boundary`).",
    ),
}

BLAME_RECORD_SCHEMA = table_schema_from(BlameRecord, _COLUMN_NOTES)

# Sample rows shown next to the schema. Small on purpose: this is a legend for
# the columns, not a data browser.
_SAMPLE_ROWS = 5


@asset(
    group_name="l3_parse",
    kinds={"python"},
    description=(
        "One record per blamed line, carrying every field git emitted about it. "
        "Pure parsing: the logic lives in pipeline.blame_parser and touches no "
        "network, disk or database."
    ),
    metadata={
        # Declared here rather than only at run time so the columns are readable
        # in the UI before anything has been materialized.
        "dagster/column_schema": BLAME_RECORD_SCHEMA,
        "grain": "one row per blamed line",
        "parser": "pipeline/blame_parser.py",
    },
)
def blame_records(
    context: AssetExecutionContext,
    blame_capture: BlameCapture,
) -> list[BlameRecord]:
    if not blame_capture.path.exists():
        # The capture is a file on disk rather than a value in the IO manager, so
        # it can outlive the run that made it -- or be swept up with the temp
        # directory. Saying which is better than an IOError halfway through.
        raise Failure(
            description=(
                f"capture for {blame_capture.slug} is gone from {blame_capture.path}. "
                "Re-materialize blame_capture, or point the workspace resource's "
                "`root` at storage that survives a reboot."
            )
        )

    text = blame_capture.path.read_text(encoding="utf-8", errors="replace")
    records = parse_blame_capture(text)

    blamed_paths = {record.blamed_file_path for record in records}
    origin_paths = {record.origin_file_path for record in records}

    context.add_output_metadata(
        {
            "repository": MetadataValue.text(blame_capture.slug),
            "records": MetadataValue.int(len(records)),
            "blamed_paths": MetadataValue.int(len(blamed_paths)),
            "origin_paths": MetadataValue.int(len(origin_paths)),
            "commits": MetadataValue.int(len({record.commit_sha for record in records})),
            "identities": MetadataValue.int(
                len({(r.author_name, r.author_email) for r in records})
            ),
            "moved_lines": MetadataValue.int(
                sum(1 for r in records if r.moved_between_files)
            ),
            "sample": MetadataValue.table(
                records=[
                    TableRecord(
                        {
                            field.name: getattr(record, field.name)
                            for field in dataclass_fields(BlameRecord)
                        }
                    )
                    for record in records[:_SAMPLE_ROWS]
                ],
                schema=BLAME_RECORD_SCHEMA,
            ),
        }
    )
    return records
