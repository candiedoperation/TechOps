"""Point Gitea webhooks at another portal port after a fixture moved between slots.

usage: gitea-rehook.py <old-portal-port> <new-portal-port>   (env: GITEA_URL-ish via GITEA_PORT, token file)
Webhooks created by the portal target host.docker.internal:<PORTAL_PORT>, so a
fixture saved from slot A would otherwise keep calling slot A's server.
"""
import json
import os
import sys
import urllib.request

old, new = sys.argv[1:3]
base = f"http://127.0.0.1:{os.environ['GITEA_PORT']}/api/v1"
token = open(os.path.join(os.environ['STATE_DIR'], '.gitea-token')).read().strip()


def call(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, headers={
        'Authorization': f'token {token}', 'Content-Type': 'application/json'},
        data=json.dumps(body).encode() if body is not None else None)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read()
        return json.loads(raw) if raw else None


def fix(prefix, hooks):
    changed = 0
    for hook in hooks or []:
        url = hook.get('config', {}).get('url', '')
        if f'host.docker.internal:{old}' in url:
            call('PATCH', f"{prefix}/{hook['id']}", {'type': hook['type'], 'config': {
                **hook['config'], 'url': url.replace(f'host.docker.internal:{old}', f'host.docker.internal:{new}')}})
            changed += 1
    return changed


total = fix('/admin/hooks', call('GET', '/admin/hooks'))
for org in call('GET', '/admin/orgs?limit=50') or []:
    total += fix(f"/orgs/{org['username']}/hooks", call('GET', f"/orgs/{org['username']}/hooks"))
for repo in (call('GET', '/repos/search?limit=50') or {}).get('data', []):
    total += fix(f"/repos/{repo['full_name']}/hooks", call('GET', f"/repos/{repo['full_name']}/hooks"))
print(f'Gitea webhooks retargeted: {total}', file=sys.stderr)
