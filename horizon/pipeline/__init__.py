"""The Horizon data pipeline: git blame into Postgres, as a Dagster asset graph.

This package only moves and shapes data: it defines no HTTP surface and owns
no request handling, so it can be run from a scheduler without starting a
server.
"""

__version__ = "0.1.0"
