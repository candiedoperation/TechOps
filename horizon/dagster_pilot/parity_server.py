"""Serve Horizon's existing production frontend over the synthetic Dagster pilot."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .runner import run_partition

PROJECT_ROOT = Path(__file__).resolve().parents[1]


def _payload(semester: str) -> dict:
    return run_partition(semester)


def _projects(data: dict) -> list[dict]:
    return [
        {"project_id": "checkout", "name": "Checkout", "short": "CO", "team": "Payments", "repo": "checkout-api", "status": "watch", "signal": "Collaborative delivery needs review", "metrics": {"active_days": 5, "open_prs": 2, "review_latency_days": 2, "merged_count": 3}, "series": {"activity": [2, 3, 4, 5], "openPRs": [1, 1, 2, 2], "reviewLatency": [1, 1, 2, 2]}, "data_completeness_pct": 100, "last_sync_at": "2026-09-13T00:00:00Z", "evidence": [{"type": "activity", "icon": "activity", "title": "Shared PR evidence", "metric": "active_days", "current": 5, "baseline": 3, "window": "semester", "threshold": "synthetic pilot", "source_refs": [{"source_type": "gitea", "source_id": "synthetic-pr-1", "source_field": "participants"}]}]},
        {"project_id": "platform", "name": "Platform", "short": "PL", "team": "Platform", "repo": "platform-ui", "status": "watch", "signal": "Partial source coverage", "metrics": {"active_days": 3, "open_prs": 1, "review_latency_days": 4, "merged_count": 1}, "series": {"activity": [3, 3, 2, 3], "openPRs": [0, 1, 1, 1], "reviewLatency": [2, 3, 4, 4]}, "data_completeness_pct": 40, "last_sync_at": "2026-09-13T00:00:00Z", "evidence": [{"type": "data", "icon": "database", "title": "Partial or stale repository activity", "metric": "active_days", "current": 3, "baseline": 4, "window": "semester", "threshold": "coverage below 100%", "source_refs": [{"source_type": "gitea", "source_id": "synthetic-platform", "source_field": "activity_coverage"}]}]},
        {"project_id": "legacy", "name": "Legacy", "short": "LE", "team": "Unassigned", "repo": "—", "status": "insufficient_data", "signal": "Trusted evidence is incomplete", "metrics": {}, "series": {}, "data_completeness_pct": None, "last_sync_at": None, "evidence": []},
    ]


def _snapshot(data: dict) -> dict:
    projects = _projects(data)
    return {"snapshot_id": f"synthetic-{data['semester']}", "snapshot_week_start": "2026-08-03", "snapshot_week_end": "2026-08-09", "generated_at": "2026-09-13T00:00:00Z", "rule_set_version": "dagster-pilot-v1", "data_completeness_pct": 80, "last_sync_at": "2026-09-13T00:00:00Z", "projects": projects, "missing_project_ids": [], "computable": False}


def _member_rows(data: dict) -> list[dict]:
    rows = []
    for login, f in data["features"]["features"].items():
        rows.append({"login": login, "name": login.title(), "organizations": ["App Dev"], "commits": f["commit_frequency"]["value"], "additions": f["sow_final_contribution"]["value"] * 10, "deletions": 0, "pulls_opened": f["collaborative_prs"]["value"], "pulls_merged": f["collaborative_prs"]["value"], "reviews_submitted": 1 if f["peer_review_average"]["value"] is not None else 0, "issues_opened": 0, "active_days": f["active_days"]["value"], "blame_lines": None, "roster_member": True, "service_or_admin": False, "has_activity": bool(f["commit_frequency"]["value"])})
    return rows


class Handler(BaseHTTPRequestHandler):
    semester = "2026-spring"

    def _send(self, body: bytes, content_type: str = "application/json", status: int = 200) -> None:
        self.send_response(status); self.send_header("Content-Type", content_type); self.send_header("Cache-Control", "no-store"); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)

    def _json(self, value: object, status: int = 200) -> None: self._send(json.dumps(value, default=str).encode(), status=status)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path); path = parsed.path; data = _payload(self.semester)
        if path == "/snapshots/latest": return self._json(_snapshot(data))
        if path == "/portfolio/delivery": return self._json({"open_prs": 3, "oldest_open_pr_days": 4, "branches_ahead": None, "open_issues": None})
        if path == "/health": return self._json({"status": "ok", "environment": "dagster-pilot", "database": "temporary-in-process", "directory_source": "synthetic_people_portal", "people_portal_configured": True, "outbound_notifications": False})
        if path == "/analytics/summary": return self._json({"run": {"run_id": f"synthetic-{self.semester}", "generated_at": "2026-09-13T00:00:00Z", "warnings": [], "history_scope": "semester"}, "totals": {"organizations": 1, "repositories": 2, "roster_members": 5, "unmatched_identities": 0, "service_accounts": 0, "active_members": 4, "commits": sum(r["commits"] for r in _member_rows(data)), "pull_requests": 4, "merged_pull_requests": 3, "issues": 0, "blame_lines": None}, "disclaimer": "Synthetic Gitea activity pilot"})
        if path == "/analytics/members": return self._json({"run": {"run_id": f"synthetic-{self.semester}", "generated_at": "2026-09-13T00:00:00Z", "history_scope": "semester", "blame_status": "disabled"}, "count": 5, "members": _member_rows(data), "disclaimer": "Synthetic Gitea activity pilot"})
        if path.startswith("/analytics/members/"):
            login = path.rsplit("/", 1)[-1]; member = next((m for m in _member_rows(data) if m["login"] == login), None); return self._json({"run": {"run_id": f"synthetic-{self.semester}"}, "member": member, "disclaimer": "Synthetic Gitea activity pilot"}, 200 if member else 404)
        if path == "/analytics/organizations": return self._json({"organizations": [{"name": "App Dev", "members": 5}]})
        if path.startswith("/recruiting/overview"):
            ranked = data["ranking"]["ranked"]; return self._json({"run": {"run_id": f"synthetic-{self.semester}", "generated_at": "2026-09-13T00:00:00Z", "llm_used": False, "signal_version": "dagster-pilot-v1", "source_warnings": ["Synthetic data"]}, "summary": {"candidate_count": len(ranked), "reviewed_count": 0, "pending_count": len(ranked), "confirmed_count": 0}, "policy": {"status": "synthetic_deterministic"}, "candidates": [{"member_login": r["member_id"], "member_name": r["member_id"].title(), "provisional_rank": i + 1, "provisional_score": r["score"] * 100, "contribution_score": r["components"].get("commits", 0) * 100, "evidence_quality_score": r["coverage"] * 100, "review_status": "pending", "source_status": "synthetic"} for i, r in enumerate(ranked)]})
        if path == "/recruiting/audit": return self._json({"run": {"run_id": f"synthetic-{self.semester}"}, "audit": {"coverage": {"synthetic": True}, "calibration": {"status": "not_calibrated"}, "flags": ["Synthetic pilot; human review required"], "recent_reviews": []}})
        if path.startswith("/recruiting/candidates/"):
            login = path.rsplit("/", 1)[-1]; f = data["features"]["features"].get(login); return self._json({"run": {"run_id": f"synthetic-{self.semester}"}, "candidate": {"member_login": login, "member_name": login.title(), "provisional_score": next((r["score"] * 100 for r in data["ranking"]["ranked"] if r["member_id"] == login), None), "review_status": "pending", "source_status": "synthetic", "stats": {"commits": f["commit_frequency"]["value"] if f else None, "reviews_submitted": 1 if f and f["peer_review_average"]["value"] is not None else 0}, "evidence_claims": [], "review_history": []}}, 200 if f else 404)
        if path.startswith("/projects/") and path.endswith("/snapshots"):
            pid = path.split("/")[2]; return self._json({"snapshots": [p for p in _projects(data) if p["project_id"] == pid]})
        if path.startswith("/projects/") and path.endswith("/boundary"):
            return self._json({"project_id": path.split("/")[2], "root_team": "synthetic", "repos": []})
        if path in {"/rules", "/audit"}: return self._json({"rules": [], "audit": {"flags": data["audit"]["flags"]}})
        if path in {"/", "/index.html"}: return self._static("index.html", "text/html; charset=utf-8")
        if path in {"/app.js", "/styles.css", "/analytics/app.js", "/analytics/styles.css", "/analytics/index.html", "/profiles/app.js", "/profiles/styles.css", "/profiles/index.html"}: return self._static(path.lstrip("/"), "text/javascript" if path.endswith(".js") else "text/css" if path.endswith(".css") else "text/html; charset=utf-8")
        if path.startswith("/assets/"): return self._static(path.lstrip("/"), "image/png")
        return self._json({"detail": "Not found"}, 404)

    def _static(self, relative: str, content_type: str) -> None:
        target = (PROJECT_ROOT / relative).resolve()
        if not target.is_relative_to(PROJECT_ROOT) or not target.exists(): return self._json({"detail": "Not found"}, 404)
        self._send(target.read_bytes(), content_type)

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/recruiting/run": return self._json({"run": {"run_id": f"synthetic-{self.semester}"}})
        if self.path == "/feedback": return self._json({"status": "recorded", "synthetic": True}, 201)
        return self._json({"detail": "Not found"}, 404)

    def log_message(self, format: str, *args: object) -> None: print(f"[horizon-dagster-parity] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(); parser.add_argument("--host", default="127.0.0.1"); parser.add_argument("--port", type=int, default=8788); parser.add_argument("--semester", default="2026-spring", choices=["2025-fall", "2026-spring"]); args = parser.parse_args(); Handler.semester = args.semester
    server = ThreadingHTTPServer((args.host, args.port), Handler); print(f"Horizon production UI parity pilot: http://{args.host}:{args.port}")
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.server_close()


if __name__ == "__main__": main()
