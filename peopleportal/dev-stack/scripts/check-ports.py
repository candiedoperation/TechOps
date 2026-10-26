"""Check host ports before startup, preserving this project's running services."""

import errno
import json
import os
import socket
import sys


def main():
    containers = json.load(sys.stdin)
    owned_ports = {
        int(binding["HostPort"])
        for container in containers
        for bindings in (container.get("NetworkSettings", {}).get("Ports") or {}).values()
        for binding in bindings or []
        if binding["HostIp"] == "127.0.0.1"
    }
    failures = []
    for key in (
        "AUTHENTIK_PORT", "GITEA_PORT", "GITEA_SSH_PORT", "MONGO_PORT",
        "REDIS_PORT", "MAILPIT_PORT", "SMTP_PORT", "PORTAL_PORT", "WEBUI_PORT",
    ):
        port = int(os.environ[key])
        if port in owned_ports and key not in ("PORTAL_PORT", "WEBUI_PORT"):
            continue
        # localhost may resolve to either loopback family for the host apps.
        for family, address in ((socket.AF_INET, "127.0.0.1"), (socket.AF_INET6, "::1")):
            if family == socket.AF_INET6 and not socket.has_ipv6:
                continue
            try:
                with socket.socket(family, socket.SOCK_STREAM) as probe:
                    if family == socket.AF_INET6:
                        probe.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
                    probe.bind((address, port))
            except OSError as error:
                if family == socket.AF_INET6 and error.errno in (
                    errno.EAFNOSUPPORT, errno.EADDRNOTAVAIL, errno.EPROTONOSUPPORT,
                ):
                    continue
                failures.append(
                    f"ERROR: {key}={port} is unavailable on {address}: {error}. "
                    f"Set {key} to a free port in dev-stack/.env "
                    f"(or export {key} before first setup), then rerun scripts/up.sh."
                )
                break
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
