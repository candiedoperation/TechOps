"""The Dagster entrypoint: ``dagster dev -m pipeline.definitions``.

Three assets as of PR 3 -- source description, raw capture, parsed records. They are
listed explicitly rather than swept up by module: a graph is worth being able
to read off one screen, and an import that silently adds an asset is how the
legacy 13-assets-in-one-file pilot happened.
"""

from __future__ import annotations

from dagster import Definitions

from .assets import blame_capture, blame_records, gitea_repository
from .checks import (
    capture_is_non_empty,
    records_carry_every_field,
    records_parse_completely,
)
from .resources import build_resources

defs = Definitions(
    assets=[gitea_repository, blame_capture, blame_records],
    asset_checks=[
        capture_is_non_empty,
        records_carry_every_field,
        records_parse_completely,
    ],
    resources=build_resources(),
)
