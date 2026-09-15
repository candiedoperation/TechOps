"""Test-wide isolation from the developer's real environment.

``backend.config`` resolves its dotenv path once at import, so PHI_ENV_FILE has
to be cleared before the module is first imported. Without this a developer's
local .env would be read into every test run.
"""

import os

os.environ["PHI_ENV_FILE"] = ""
os.environ.setdefault("PHI_ENVIRONMENT", "test")
