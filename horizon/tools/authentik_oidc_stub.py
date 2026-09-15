#!/usr/bin/env python3
"""Disposable Authentik/OIDC read surface for the local live-stack test.

This is deliberately a tiny test dependency, not an authentication server.
It exposes only the Authentik directory reads and idempotent writes People
Portal performs during local boot, plus OIDC discovery so the real People
Portal process initializes. Horizon still authenticates to People Portal with
the configured local service bearer; no production credential is involved.
"""

from __future__ import annotations

import argparse
import copy
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def load_state(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        raw = json.load(handle)
    users = {str(user["pk"]): user for user in raw.get("users", [])}
    groups = {str(group["pk"]): group for group in raw.get("groups", [])}
    return {"users": users, "groups": groups, "next_group": 1}


def user_projection(user: dict) -> dict:
    return {
        "pk": user["pk"],
        "username": user["username"],
        "name": user["name"],
        "email": user["email"],
        "is_active": user.get("is_active", True),
        "attributes": user.get("attributes", {}),
        "date_joined": "2026-01-01T00:00:00Z",
        "last_login": None,
        "groups": [],
        "groups_obj": [],
        "type": "internal",
        "is_superuser": False,
    }


def brief_group(group: dict, state: dict) -> dict:
    return {
        "pk": group["pk"],
        "name": group["name"],
        "parent": group.get("parent"),
        "parents": [group["parent"]] if group.get("parent") else [],
        "attributes": group.get("attributes", {}),
        "children": list(group.get("children", [])),
    }


def group_payload(group: dict, state: dict, *, include_users: bool, include_children: bool, include_parents: bool) -> dict:
    payload = brief_group(group, state)
    if include_users:
        payload["users_obj"] = [
            user_projection(state["users"][str(pk)])
            for pk in group.get("user_pks", [])
            if str(pk) in state["users"]
        ]
    if include_children:
        payload["children_obj"] = [
            brief_group(state["groups"][str(pk)], state)
            for pk in group.get("children", [])
            if str(pk) in state["groups"]
        ]
    if include_parents and group.get("parent"):
        parent = state["groups"].get(str(group["parent"]))
        payload["parents_obj"] = [brief_group(parent, state)] if parent else []
    else:
        payload["parents_obj"] = []
    return payload


class Handler(BaseHTTPRequestHandler):
    state: dict
    token: str

    def log_message(self, format: str, *args: object) -> None:
        print(f"[authentik-stub] {self.address_string()} - {format % args}", flush=True)

    def _json(self, status: int, value: object) -> None:
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        return json.loads(self.rfile.read(length) or b"{}")

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        query = parse_qs(parsed.query)
        if path in {
            "/.well-known/openid-configuration",
            "/application/o/people-portal/.well-known/openid-configuration",
        }:
            base = f"http://{self.headers.get('Host', 'authentik-stub:9000')}"
            self._json(200, {
                "issuer": base,
                "authorization_endpoint": f"{base}/application/o/authorize/",
                "token_endpoint": f"{base}/application/o/token/",
                "userinfo_endpoint": f"{base}/application/o/userinfo/",
                "jwks_uri": f"{base}/jwks.json",
                "scopes_supported": ["openid", "profile", "email"],
                "response_types_supported": ["code"],
                "grant_types_supported": ["authorization_code", "refresh_token"],
            })
            return
        if path == "/jwks.json":
            self._json(200, {"keys": []})
            return
        if path == "/api/v3/admin/version":
            self._json(200, {"version_current": "2026.5.0"})
            return
        if path == "/api/v3/core/users":
            users = list(self.state["users"].values())
            username = query.get("username", [None])[0]
            if username:
                users = [user for user in users if user.get("username") == username]
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = max(1, int(query.get("page_size", ["100"])[0]))
            start = (page - 1) * page_size
            rows = [user_projection(user) for user in users[start:start + page_size]]
            total_pages = max(1, (len(users) + page_size - 1) // page_size)
            self._json(200, {
                "results": rows,
                "pagination": {
                    "count": len(users), "current": page, "total_pages": total_pages,
                    "next": page + 1 if page < total_pages else None,
                    "previous": page - 1 if page > 1 else None,
                },
            })
            return
        if path.startswith("/api/v3/core/users/"):
            pk = path.rsplit("/", 1)[-1]
            user = self.state["users"].get(pk)
            self._json(200 if user else 404, user_projection(user) if user else {"detail": "not found"})
            return
        if path == "/api/v3/core/groups":
            groups = list(self.state["groups"].values())
            name = query.get("name", [None])[0]
            if name:
                groups = [group for group in groups if group.get("name") == name]
            username = query.get("members_by_username", [None])[0]
            if username:
                user = next((item for item in self.state["users"].values() if item.get("username") == username), None)
                groups = [group for group in groups if user and user["pk"] in group.get("user_pks", [])]
            groups.sort(key=lambda group: group["name"])
            page = max(1, int(query.get("page", ["1"])[0]))
            page_size = max(1, int(query.get("page_size", ["100"])[0]))
            start = (page - 1) * page_size
            include_users = query.get("include_users", ["false"])[0].lower() == "true"
            include_children = query.get("include_children", ["false"])[0].lower() == "true"
            include_parents = query.get("include_parents", ["false"])[0].lower() == "true"
            rows = [
                group_payload(group, self.state, include_users=include_users, include_children=include_children, include_parents=include_parents)
                for group in groups[start:start + page_size]
            ]
            total_pages = max(1, (len(groups) + page_size - 1) // page_size)
            self._json(200, {
                "results": rows,
                "pagination": {
                    "count": len(groups), "current": page, "total_pages": total_pages,
                    "next": page + 1 if page < total_pages else None,
                    "previous": page - 1 if page > 1 else None,
                },
            })
            return
        if path.startswith("/api/v3/core/groups/"):
            pk = path.rsplit("/", 1)[-1]
            group = self.state["groups"].get(pk)
            if not group:
                self._json(404, {"detail": "not found"})
                return
            self._json(200, group_payload(group, self.state, include_users=True, include_children=True, include_parents=True))
            return
        if path in {"", "/health", "/healthz"}:
            self._json(200, {"status": "ok"})
            return
        self._json(404, {"detail": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/")
        if path == "/api/v3/core/groups":
            body = self._body()
            parents = body.get("parents") or []
            parent = str(parents[0]) if parents else None
            attributes = copy.deepcopy(body.get("attributes") or {})
            attributes.setdefault("peoplePortalCreation", True)
            attributes.setdefault("rootTeamSettings", {})
            attributes.setdefault("bindlePermissions", {})
            next_id = self.state["next_group"]
            self.state["next_group"] += 1
            pk = f"stub-group-{next_id}"
            group = {"pk": pk, "name": str(body.get("name") or pk), "parent": parent, "children": [], "user_pks": [], "attributes": attributes}
            self.state["groups"][pk] = group
            if parent and parent in self.state["groups"]:
                self.state["groups"][parent].setdefault("children", []).append(pk)
            self._json(201, group_payload(group, self.state, include_users=True, include_children=True, include_parents=True))
            return
        if path == "/api/v3/core/users":
            body = self._body()
            pk = max([int(user["pk"]) for user in self.state["users"].values()] + [1100]) + 1
            user = {"pk": pk, "username": body.get("username", f"stub-user-{pk}"), "name": body.get("name", "Stub User"), "email": body.get("email", "stub@example.invalid"), "is_active": body.get("is_active", True), "attributes": body.get("attributes", {})}
            self.state["users"][str(pk)] = user
            self._json(201, user_projection(user))
            return
        self._json(404, {"detail": "not found"})

    def do_PATCH(self) -> None:  # noqa: N802
        path = urlparse(self.path).path.rstrip("/")
        if path.startswith("/api/v3/core/groups/"):
            pk = path.rsplit("/", 1)[-1]
            group = self.state["groups"].get(pk)
            if not group:
                self._json(404, {"detail": "not found"})
                return
            body = self._body()
            group["attributes"].update(body.get("attributes") or {})
            self._json(200, group_payload(group, self.state, include_users=True, include_children=True, include_parents=True))
            return
        self._json(404, {"detail": "not found"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9000)
    parser.add_argument("--fixture", type=Path, default=Path("/app/authentik_oidc_fixture.json"))
    args = parser.parse_args()
    Handler.state = load_state(args.fixture)
    Handler.token = "local-authentik-token"
    server = ThreadingHTTPServer((args.bind, args.port), Handler)
    print(f"[authentik-stub] serving {args.fixture} at http://{args.bind}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
