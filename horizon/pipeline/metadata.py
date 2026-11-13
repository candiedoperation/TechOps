"""Turning the dataclasses assets return into schemas Dagster can render.

Dagster shows two different things: metadata declared on the asset definition,
which is visible as soon as the code loads, and metadata attached during a run,
which is not there until something materializes. Descriptions of what an asset
produces belong in the first kind -- a graph nobody has run yet should still
explain itself.
"""

from __future__ import annotations

from dataclasses import fields as dataclass_fields

from dagster import TableColumn, TableSchema


def table_schema_from(record_type: type, notes: dict[str, tuple[str, str]]) -> TableSchema:
    """Describe a dataclass as a Dagster table schema.

    Built from the type rather than written out beside it, so renaming a field
    without describing it raises on import instead of leaving the UI showing a
    description that quietly refers to something that no longer exists.
    """

    names = [field.name for field in dataclass_fields(record_type)]
    undocumented = [name for name in names if name not in notes]
    if undocumented:
        raise RuntimeError(
            f"{record_type.__name__} fields with no column note: {undocumented}"
        )

    return TableSchema(
        columns=[
            TableColumn(name=name, type=notes[name][0], description=notes[name][1])
            for name in names
        ]
    )
