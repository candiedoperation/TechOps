# Runs only inside the pinned authentik image, which supplies Python.
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode

base = 'http://authentik-server:9000'
token = os.environ['AUTHENTIK_BOOTSTRAP_TOKEN']

def get(path, method='GET'):
    req = urllib.request.Request(base + path, method=method,
                                 headers={'Authorization': f'Bearer {token}'})
    with urllib.request.urlopen(req, timeout=10) as response:
        return json.load(response)

def provider(slug, client_id):
    app = get(f'/api/v3/core/applications/{slug}/')
    obj = get(f"/api/v3/providers/oauth2/{app['provider']}/")
    if not obj.get('signing_key'):
        raise ValueError('Asymmetric signing certificate not ready')
    if obj['client_id'] != client_id or not obj.get('client_secret'):
        raise ValueError('Blueprint client credentials not ready')
    expected_secret = os.environ['PORTAL_OIDC_CLIENT_SECRET' if slug == 'people-portal' else 'GITEA_OIDC_CLIENT_SECRET']
    if obj['client_secret'] != expected_secret:
        raise ValueError('Blueprint client secret not reconciled yet')
    if not {'authorization_code', 'refresh_token'} <= set(obj['grant_types']):
        raise ValueError('Blueprint grant_types not ready')
    return obj

# Crypto reconciliation creates this keypair independently of blueprint defaults.
# Wait for it before requesting a retry of a blueprint that ran too early.
reapplied = False
for attempt in range(180):
    try:
        certs = get('/api/v3/crypto/certificatekeypairs/?' + urlencode(
            {'name': 'authentik Self-signed Certificate'}))['results']
        if not any(cert['name'] == 'authentik Self-signed Certificate'
                   and cert.get('private_key_available') for cert in certs):
            raise ValueError('Default signing certificate not ready')
        if not reapplied:
            for path in (
                'default/flow-default-provider-authorization-implicit-consent.yaml',
                'default/flow-default-provider-invalidation.yaml',
                'default/flow-default-invalidation-flow.yaml',
                'system/providers-oauth2.yaml',
            ):
                if not get('/api/v3/managed/blueprints/?' + urlencode({'path': path}))['results']:
                    raise ValueError('Default blueprint instance not discovered yet')
            instances = get('/api/v3/managed/blueprints/?' + urlencode(
                {'path': 'custom/people-portal.yaml'}))['results']
            if not instances:
                raise ValueError('Custom blueprint instance not discovered yet')
            get(f"/api/v3/managed/blueprints/{instances[0]['pk']}/apply/", method='POST')
            reapplied = True
        portal = provider('people-portal', os.environ['PORTAL_OIDC_CLIENT_ID'])
        gitea = provider('gitea', os.environ['GITEA_OIDC_CLIENT_ID'])
        break
    except (urllib.error.URLError, ValueError, KeyError, TypeError) as error:
        if attempt == 179:
            raise SystemExit(f'authentik bootstrap timed out: {error}; check worker blueprints and bootstrap token')
        print(f'Waiting for authentik defaults/blueprint ({attempt + 1}/180): {error}', file=sys.stderr)
        time.sleep(2)

lines = []

def emit(name, value):
    # Both Bash and Compose can safely source/read this generated file.
    if "'" in value or '\n' in value or '\r' in value:
        raise SystemExit('Unexpected character in OIDC credential')
    lines.append(f"{name}='{value}'")

emit('PORTAL_OIDC_CLIENT_ID', portal['client_id'])
emit('PORTAL_OIDC_CLIENT_SECRET', portal['client_secret'])
emit('GITEA_OIDC_CLIENT_ID', gitea['client_id'])
emit('GITEA_OIDC_CLIENT_SECRET', gitea['client_secret'])
print('\n'.join(lines))
