"""Small stdlib HTTP server for the local synthetic pilot UI."""
from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .runner import run_partition

ROOT = Path(__file__).parent


class Handler(BaseHTTPRequestHandler):
    def _send(self, body: bytes, content_type: str, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed = urlparse(self.path)
        if parsed.path == "/api/run":
            semester = parse_qs(parsed.query).get("semester", ["2026-spring"])[0]
            try:
                body = json.dumps(run_partition(semester), default=str).encode()
                self._send(body, "application/json")
            except ValueError as exc:
                self._send(json.dumps({"error": str(exc)}).encode(), "application/json", 400)
            except Exception as exc:  # surface local pilot failures to the UI
                self._send(json.dumps({"error": f"pilot execution failed: {type(exc).__name__}: {exc}"}).encode(), "application/json", 500)
            return
        if parsed.path in {"/", "/index.html"}:
            self._send((ROOT / "index.html").read_bytes(), "text/html; charset=utf-8")
            return
        if parsed.path == "/app.js":
            self._send((ROOT / "app.js").read_bytes(), "text/javascript; charset=utf-8")
            return
        if parsed.path == "/styles.css":
            self._send((ROOT / "styles.css").read_bytes(), "text/css; charset=utf-8")
            return
        self._send(b"Not found", "text/plain", 404)

    def log_message(self, format: str, *args: object) -> None:
        print(f"[pilot-ui] {format % args}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Serve the isolated synthetic Dagster pilot UI")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Dagster pilot UI: http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
