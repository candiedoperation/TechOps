#!/usr/bin/env python3
"""Trigger scheduled refresh on the API that owns the persistent database."""
import argparse
import json
import os
import sys
from urllib.parse import urlencode
from urllib.request import Request, urlopen


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("job", choices=["nightly", "weekly"])
    parser.add_argument("--lookback-days", type=int, default=14)
    parser.add_argument("--week-start")
    args = parser.parse_args()
    base, token = os.getenv("PHI_API_BASE"), os.getenv("PHI_ADMIN_SYNC_TOKEN")
    if not base or not token:
        parser.error("PHI_API_BASE and PHI_ADMIN_SYNC_TOKEN are required")
    params = {"lookback_days": args.lookback_days} if args.job == "nightly" else {"week_start": args.week_start} if args.week_start else {}
    request = Request(f"{base.rstrip('/')}/admin/sync/{args.job}?{urlencode(params)}", data=b"",
                      headers={"X-Admin-Sync-Token": token}, method="POST")
    try:
        with urlopen(request, timeout=300) as response:
            report = json.load(response)
        print(json.dumps(report, indent=2))
        return 0 if report.get("status") in {"ok", "partial"} else 1
    except Exception as exc:
        print(f"Refresh request failed ({type(exc).__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
