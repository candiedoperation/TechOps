"""Blame parsing: raw blame text into records. Pure, apart from reading capture.

The parsing itself lives in ``pipeline.blame_parser`` and touches nothing. This
asset is only the shell around it: read the file the capture layer wrote, hand
the text over, attach counts. That separation is the point -- the logic legacy
got wrong is reachable from a test with a string and no repository.
"""

# No `from __future__ import annotations` in this module: Dagster resolves the
# context and asset-input annotations at decoration time, and PEP 563 turns them
# into strings it then refuses.
from dataclasses import fields as dataclass_fields

from dagster import (
    AssetExecutionContext,
    Failure,
    MetadataValue,
    TableColumn,
    TableRecord,
    TableSchema,
    asset,
)

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

# The table schema is the machine-readable contract, but it is not the most
# discoverable view in Dagster's asset page. Keep an explicit field catalogue
# beside it so the page also shows exactly what the parser pulled and where
# each value came from.
_FIELD_SOURCES = {
    "organization": "capture section header",
    "repository": "capture section header",
    "blamed_file_path": "capture section header",
    "line_number_in_file": "blame header final-line number",
    "commit_sha": "blame header SHA",
    "commit_summary": "git summary",
    "consecutive_line_count": "blame header group count",
    "line_number_at_origin": "blame header original-line number",
    "author_name": "git author",
    "author_email": "git author-mail",
    "authored_at_epoch": "git author-time",
    "author_utc_offset": "git author-tz",
    "committer_name": "git committer",
    "committer_email": "git committer-mail",
    "committed_at_epoch": "git committer-time",
    "committer_utc_offset": "git committer-tz",
    "origin_file_path": "git filename",
    "previous_commit_sha": "git previous SHA",
    "previous_file_path": "git previous path",
    "reaches_history_boundary": "git boundary marker",
}

_PARSED_ATTRIBUTES = [
    {
        "name": field.name,
        "type": _COLUMN_NOTES[field.name][0],
        "source": _FIELD_SOURCES[field.name],
        "description": _COLUMN_NOTES[field.name][1],
    }
    for field in dataclass_fields(BlameRecord)
]

if set(_FIELD_SOURCES) != set(_COLUMN_NOTES):
    raise RuntimeError("every parsed field must have a source and column note")

BLAME_RECORD_SCHEMA = table_schema_from(BlameRecord, _COLUMN_NOTES)

_ATTRIBUTE_PREVIEW_SCHEMA = TableSchema(
    columns=[
        TableColumn(
            name="attribute",
            type="string",
            description="Name of the field emitted by the blame parser.",
        ),
        TableColumn(
            name="type",
            type="string",
            description="Dagster display type for the parsed field.",
        ),
        TableColumn(
            name="source",
            type="string",
            description="The porcelain field or capture context the value came from.",
        ),
        TableColumn(
            name="description",
            type="string",
            description="What the parsed field means.",
        ),
    ]
)

_ATTRIBUTE_PREVIEW = [
    TableRecord(
        {
            "attribute": attribute["name"],
            "type": attribute["type"],
            "source": attribute["source"],
            "description": attribute["description"],
        }
    )
    for attribute in _PARSED_ATTRIBUTES
]

# Sample rows shown next to the schema. Small on purpose: this is a legend for
# the columns, not a data browser.
_SAMPLE_ROWS = 5


@asset(
    group_name="03_parse",
    kinds={"python"},
    description=(
        "One record per blamed line, carrying every field git emitted about it. "
        "Pure parsing: the logic lives in pipeline.blame_parser and touches no "
        "network, disk or database. See `parsed_attributes` for the complete "
        "field list and each field's source."
    ),
    metadata={
        # Declared here rather than only at run time so the columns are readable
        # in the UI before anything has been materialized.
        "dagster/column_schema": BLAME_RECORD_SCHEMA,
        "attribute_preview": MetadataValue.table(
            records=_ATTRIBUTE_PREVIEW,
            schema=_ATTRIBUTE_PREVIEW_SCHEMA,
        ),
        "parsed_attributes": MetadataValue.json(_PARSED_ATTRIBUTES),
        "grain": "one row per blamed line",
        "parser": "pipeline/blame_parser.py",
    },
)
def blame_records(
    context: AssetExecutionContext,
    blame_capture: BlameCapture,
) -> list[BlameRecord]:
    if blame_capture.files_failed:
        failed_paths = ", ".join(blame_capture.failed_paths) or "see capture metadata"
        raise Failure(
            description=(
                f"Blame capture for {blame_capture.slug} is incomplete: "
                f"{blame_capture.files_failed} of {blame_capture.files_tracked} tracked "
                f"files failed. First failed paths: {failed_paths}."
            )
        )
    if not blame_capture.captured_paths:
        raise Failure(
            description=(
                f"Blame capture for {blame_capture.slug} contained no non-empty text files "
                f"({blame_capture.files_tracked} tracked, "
                f"{blame_capture.files_skipped_binary} binary, {blame_capture.files_empty} empty)."
            )
        )
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
    if not records:
        raise Failure(
            description=(
                f"The capture for {blame_capture.slug} listed "
                f"{len(blame_capture.captured_paths)} files but parsed zero blamed lines."
            )
        )

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
            "parsed_attributes": MetadataValue.json(_PARSED_ATTRIBUTES),
        }
    )
    return records
