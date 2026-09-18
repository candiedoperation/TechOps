"""Test-wide isolation from the developer's real environment.

``pipeline.config`` resolves its dotenv path once at import, so HORIZON_ENV_FILE has
to be cleared before the module is first imported.

That alone is not enough: Nx's ``run-commands`` executor loads ``horizon/.env``
into the task environment before the command starts, and pydantic reads real
environment variables whether or not dotenv loading is switched off. So the
settings variables are also scrubbed from ``os.environ`` here -- otherwise a
developer's live Gitea URL and API token silently configure the test run, and a
test asserting an unset default passes or fails depending on whose machine it
is.
"""

import os

# Unprefixed aliases accepted by pipeline.config.PipelineSettings. The
# PHI_/HORIZON_ forms are covered by the prefix sweep below.
_UNPREFIXED_SETTING_NAMES = frozenset({"DATABASE_URL"})

for _name in [
    key
    for key in os.environ
    if key.startswith(("PHI_", "HORIZON_")) or key in _UNPREFIXED_SETTING_NAMES
]:
    del os.environ[_name]

os.environ["HORIZON_ENV_FILE"] = ""
