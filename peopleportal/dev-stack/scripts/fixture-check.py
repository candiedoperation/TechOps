"""Cross-service consistency check for a slot: Mongo references vs Authentik pks.

Group pks live in Mongo as teamPk/subteamPk/hiredSubteamPk/recruitingSubteamPks
(strings); user pks as userPk/inviterPk/requestorPk (numbers). Anything that does
not exist in Authentik is reported. Exit 1 when orphans are found.
env: AUTHENTIK_PORT, AUTHENTIK_BOOTSTRAP_TOKEN, COMPOSE_PROJECT_NAME
"""
import json
import os
import subprocess
import sys
import urllib.request

GROUP_KEYS = {'teamPk', 'subteamPk', 'hiredSubteamPk', 'recruitingSubteamPks'}
USER_KEYS = {'userPk', 'inviterPk', 'requestorPk'}
base = f"http://127.0.0.1:{os.environ['AUTHENTIK_PORT']}/api/v3"
hdr = {'Authorization': f"Bearer {os.environ['AUTHENTIK_BOOTSTRAP_TOKEN']}"}


def fetch(path):
    out, url = [], base + path
    while url:
        with urllib.request.urlopen(urllib.request.Request(url, headers=hdr), timeout=30) as resp:
            data = json.load(resp)
        out += data['results']
        nxt = data['pagination']['next']
        url = f"{base}{path}{'&' if '?' in path else '?'}page={nxt}" if nxt else None
    return out


groups = {str(g['pk']) for g in fetch('/core/groups/?page_size=200&include_users=false')}
users = {int(u['pk']) for u in fetch('/core/users/?page_size=200')}
js = '''
const out = [];
const walk = (coll, id, v, path) => {
  if (Array.isArray(v)) return v.forEach((x) => walk(coll, id, x, path));
  if (v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date)) {
    return Object.entries(v).forEach(([k, x]) => walk(coll, id, x, k));
  }
  out.push([coll, String(id), path, v]);
};
db.getCollectionNames().forEach((c) => db[c].find().forEach((d) => walk(c, d._id, d, "")));
print(JSON.stringify(out));
'''
raw = subprocess.run(['docker', 'compose', '-p', os.environ['COMPOSE_PROJECT_NAME'], 'exec', '-T', 'mongo',
                      'mongosh', '--quiet', 'people-portal', '--eval', js], capture_output=True, check=True).stdout
rows = json.loads(raw.decode().strip().splitlines()[-1])
bad, checked = [], 0
for coll, doc, key, val in rows:
    if key in GROUP_KEYS and isinstance(val, str):
        checked += 1
        if val not in groups:
            bad.append(f'{coll}/{doc}.{key}={val} (no such Authentik group)')
    elif key in USER_KEYS and isinstance(val, (int, float)):
        checked += 1
        if int(val) not in users:
            bad.append(f'{coll}/{doc}.{key}={val} (no such Authentik user)')
print(f'consistency: {checked} cross-service references checked, {len(bad)} orphaned', file=sys.stderr)
for line in bad[:30]:
    print('  ORPHAN ' + line, file=sys.stderr)
sys.exit(1 if bad else 0)
