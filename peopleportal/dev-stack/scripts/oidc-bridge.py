"""Loopback-only OIDC forwarding inside Gitea's network namespace."""
import http.client
import os
import socket
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Bridge(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/health":
            self.send_response(200)
            self.end_headers()
            return
        self.forward()

    def do_POST(self):
        self.forward()

    def forward(self):
        if not self.path.startswith("/application/o/"):
            self.send_error(404)
            return
        upstream = http.client.HTTPConnection("authentik-server", 9000, timeout=15)
        try:
            body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
            # Preserve public Host for discovery, issuer and JWT consistency.
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() not in {"connection", "transfer-encoding"}}
            upstream.request(self.command, self.path, body=body, headers=headers)
            response = upstream.getresponse()
            data = response.read()
            self.send_response(response.status)
            for key, value in response.getheaders():
                if key.lower() not in {"connection", "transfer-encoding", "content-length"}:
                    self.send_header(key, value)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
        except (OSError, http.client.HTTPException):
            self.send_error(502, "Authentik upstream unavailable")
        finally:
            upstream.close()

    def log_message(self, *_args):
        # OAuth query strings contain authorization codes. Do not log them.
        pass


class IPv6LoopbackServer(ThreadingHTTPServer):
    address_family = socket.AF_INET6


port = int(os.environ["AUTHENTIK_PORT"])
ipv6 = IPv6LoopbackServer(("::1", port), Bridge)
threading.Thread(target=ipv6.serve_forever, daemon=True).start()
ThreadingHTTPServer(("127.0.0.1", port), Bridge).serve_forever()
