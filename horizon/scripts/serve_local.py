#!/usr/bin/env python3
"""Serve the official Horizon frontend and proxy its local API same-origin.

The in-app browser allows the local frontend origin but can block browser
requests to a second localhost port. Keeping the API proxy here makes local
development behave like the deployed single-origin app without changing the
FastAPI service or exposing the API beyond localhost.
"""

from __future__ import annotations

import argparse
import json
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
from urllib.parse import unquote, urlsplit


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_BACKEND = "http://127.0.0.1:8000"


def is_api_route(path: str) -> bool:
    route = path.split("?", 1)[0].rstrip("/")
    if route in {"", "/", "/analytics", "/profiles"}:
        return False
    if route in {"/analytics/index.html", "/analytics/app.js", "/analytics/styles.css"}:
        return False
    return route in {
        "/health",
        "/rules",
        "/boundaries",
        "/audit",
        "/feedback",
        "/progress",
        "/snapshots",
        "/portfolio",
    } or route.startswith((
        "/artifacts/",
        "/ci/",
        "/data/horizon/",
        "/analytics/",
        "/admin/",
        "/portfolio/",
        "/projects/",
        "/progress/",
        "/recruiting/",
        "/snapshots/",
    ))


class LocalHorizonHandler(SimpleHTTPRequestHandler):
    backend_base = DEFAULT_BACKEND

    def end_headers(self) -> None:
        # The local app is actively developed and the inline API bootstrap is
        # part of index.html. Avoid leaving a stale failed-fetch page in the
        # in-app browser after restarting the local server.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def public_static(self) -> bool:
        route = unquote(urlsplit(self.path).path)
        path = (PROJECT_ROOT / route.lstrip("/")).resolve()
        allowed = {"/", "/index.html", "/app.js", "/styles.css",
                   "/analytics/", "/analytics/index.html", "/analytics/app.js", "/analytics/styles.css",
                   "/profiles/", "/profiles/index.html", "/profiles/app.js", "/profiles/styles.css"}
        return path.is_relative_to(PROJECT_ROOT) and (route in allowed or route.startswith("/assets/")) and not any(part.startswith(".") for part in Path(route).parts)

    def do_HEAD(self) -> None:  # noqa: N802
        if self.public_static():
            super().do_HEAD()
        else:
            self.send_error(404)

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        if is_api_route(self.path):
            self.proxy_request()
        elif self.public_static():
            super().do_GET()
        else:
            self.send_error(404)

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler API
        self.proxy_request()

    def do_PUT(self) -> None:  # noqa: N802 - stdlib handler API
        self.proxy_request()

    def do_OPTIONS(self) -> None:  # noqa: N802 - stdlib handler API
        if is_api_route(self.path):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Admin-Sync-Token, X-Reviewer-Id, X-Agent-Ingest-Token")
            self.end_headers()
        else:
            self.send_error(405)

    def proxy_request(self) -> None:
        if not is_api_route(self.path):
            self.send_error(404)
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0") or "0")
        except ValueError:
            self.send_error(400)
            return
        if not 0 <= content_length <= 128 * 1024 * 1024:
            self.send_error(413)
            return
        body = self.rfile.read(content_length) if content_length else None
        headers = {
            "Accept": self.headers.get("Accept", "application/json"),
        }
        for name in ("Authorization", "Content-Type", "X-Admin-Sync-Token", "X-Reviewer-Id", "X-Agent-Ingest-Token"):
            value = self.headers.get(name)
            if value:
                headers[name] = value

        route = self.path.replace("/data/horizon/", "/artifacts/", 1) if self.path.startswith("/data/horizon/") else self.path
        request = Request(
            f"{self.backend_base}{route}",
            data=body,
            headers=headers,
            method=self.command,
        )
        try:
            with urlopen(request, timeout=120) as response:
                self.write_proxy_response(response.status, response.headers, response.read())
        except HTTPError as error:
            self.write_proxy_response(error.code, error.headers, error.read())
        except (OSError, URLError) as error:
            payload = json.dumps({"detail": f"Local API unavailable: {error}"}).encode("utf-8")
            self.write_proxy_response(502, {"Content-Type": "application/json"}, payload)

    def write_proxy_response(self, status: int, headers, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", headers.get("Content-Type", "application/json"))
        for name in ("Content-Security-Policy", "X-Content-Type-Options", "Content-Disposition", "WWW-Authenticate"):
            if headers.get(name):
                self.send_header(name, headers.get(name))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def list_directory(self, path):
        self.send_error(404)
        return None

    def log_message(self, format: str, *args) -> None:
        print(f"[local-horizon] {self.address_string()} - {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4173)
    parser.add_argument("--backend", default=os.getenv("PHI_API_BASE", DEFAULT_BACKEND))
    args = parser.parse_args()

    os.chdir(PROJECT_ROOT)
    LocalHorizonHandler.backend_base = args.backend.rstrip("/")
    server = ThreadingHTTPServer((args.bind, args.port), LocalHorizonHandler)
    print(f"Serving {PROJECT_ROOT} at http://{args.bind}:{args.port}/")
    print(f"Proxying API routes to {LocalHorizonHandler.backend_base}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
