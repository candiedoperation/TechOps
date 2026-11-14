"""Generate the public contract artifact; never include credentials or records."""

import json
from pathlib import Path

from .config import Settings
from .main import create_app

if __name__ == "__main__":
    schema = create_app(Settings(_env_file=None)).openapi()
    Path("openapi.json").write_text(json.dumps(schema, indent=2) + "\n")
