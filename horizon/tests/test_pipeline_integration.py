"""Production regressions: source versions, identity, review state and artifacts."""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
from argparse import Namespace
from pathlib import Path

import httpx
import pytest
from fastapi import FastAPI

from backend.artifact_api import router as artifact_router
from backend.auth import get_current_user
from backend.config import Settings, get_settings
from backend.member_analytics import ingest_payload
from backend.models import RecruitingSourceRunDocument
from backend.recruiting import persist_people_portal_payload, run_recruiting_pipeline
from scripts.build_llm_ranking_export import build as build_export
from tests.test_llm_ranking_export import pipeline as synthetic_pipeline

pipeline = synthetic_pipeline

STAMP = "2026-09-01T00:00:00Z"


def analytics(**updates):
    return {"generated_at": STAMP, "members": [{"login": "git-account", "email": "member@example.test", "commits": 9}], **updates}


def portal(candidates=None, **updates):
    return {"generated_at": STAMP, "candidates": candidates if candidates is not None else [
        {"member_login": "portal-account", "email": "member@example.test", "resume": {"evidence": ["Built an API."]}}
    ], **updates}


def test_people_portal_api_sync_posts_only_the_gitea_run_id(monkeypatch):
    import run_pipeline

    captured: dict[str, object] = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"source": {"candidates": 2}, "run": {"run_id": "recruiting-run"}}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["method"] = request.method
        captured["headers"] = dict(request.headers)
        captured["body"] = json.loads(request.data.decode("utf-8"))
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(run_pipeline.urllib.request, "urlopen", fake_urlopen)
    result = run_pipeline.sync_recruiting_from_people_portal_api(
        "http://horizon.example.test", "admin-secret", "gitea-run-123"
    )

    assert result["source"]["candidates"] == 2
    assert captured["url"] == "http://horizon.example.test/admin/sync/recruiting"
    assert captured["method"] == "POST"
    assert captured["body"] == {"member_analytics_run_id": "gitea-run-123"}
    assert captured["headers"]["X-admin-sync-token"] == "admin-secret"
    assert captured["timeout"] == 300


async def test_email_join_keeps_one_person_and_detail_uses_scored_snapshot(empty_app_client, in_memory_store):
    await ingest_payload(analytics())
    await persist_people_portal_payload(in_memory_store, portal())
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    signals = await in_memory_store.recruiting_signals_for_run(run.run_id)
    assert len(signals) == 1
    detail = (await empty_app_client.get('/recruiting/candidates/portal-account', params={'run_id': run.run_id})).json()['candidate']
    assert detail['member_stats']['commits'] == 9
    assert detail['member_stats']['pulls_merged'] is None
    assert detail['resume']['evidence'] == ['Built an API.']
    assert detail['resume_score'] is None  # Unsanitized prose is never a model/scoring input.


async def test_profile_canonical_metrics_survive_raw_analytics_join(in_memory_store):
    await ingest_payload(analytics())
    await persist_people_portal_payload(in_memory_store, portal([{
        'member_login': 'portal-account', 'email': 'member@example.test', 'person_id': 'member@example.test',
        'gitea_logins': ['git-account'], 'member_stats': {'commits': None, 'availability': {'commits': 'partial'}}
    }], schema='horizon.recruiting-source.v2'))
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    signal, = await in_memory_store.recruiting_signals_for_run(run.run_id)
    assert signal.source_candidate.member_stats.commits is None
    assert signal.provisional_score is None
    assert signal.provisional_rank is None


async def test_sources_with_equal_timestamps_never_mix_and_empty_source_is_valid(in_memory_store):
    for source_id, login in [('a', 'one'), ('b', 'two')]:
        await persist_people_portal_payload(in_memory_store, portal([{'member_login': login}], source_run_id=source_id))
    first = await run_recruiting_pipeline(in_memory_store, settings=Settings(), source_run_id='a')
    assert [row.member_login for row in await in_memory_store.recruiting_signals_for_run(first.run_id)] == ['one']
    await persist_people_portal_payload(in_memory_store, portal([], source_run_id='empty'))
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings(), source_run_id='empty')
    assert run.candidate_count == 0
    assert await in_memory_store.recruiting_signals_for_run(run.run_id) == []


async def test_source_mutation_rejected_and_repeated_runs_preserve_reviews(empty_app_client, in_memory_store):
    payload = portal([{'member_login': 'one', 'member_stats': {'commits': 3}}], source_run_id='stable')
    await persist_people_portal_payload(in_memory_store, payload)
    await persist_people_portal_payload(in_memory_store, payload)
    with pytest.raises(ValueError, match='different content'):
        await persist_people_portal_payload(in_memory_store, {**payload, 'candidates': []})
    runs = await asyncio.gather(*(run_recruiting_pipeline(in_memory_store, settings=Settings()) for _ in range(3)))
    assert len({run.run_id for run in runs}) == 1
    response = await empty_app_client.post('/recruiting/reviews', json={
        'run_id': runs[0].run_id, 'member_login': 'one', 'decision': 'confirm',
        'eligibility_decision': 'eligible', 'note': 'Verified evidence; discovery review only.'})
    assert response.status_code == 201
    again = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    assert again.reviewed_count == 1
    assert len(await in_memory_store.recruiting_reviews_for_run(again.run_id)) == 1


async def test_atomic_source_ingest_rolls_back_members_if_envelope_fails(in_memory_store, monkeypatch):
    original = in_memory_store.add
    async def fail(collection, item):
        if collection == 'recruiting_sources':
            raise RuntimeError('simulated disk error')
        return await original(collection, item)
    monkeypatch.setattr(in_memory_store, 'add', fail)
    with pytest.raises(RuntimeError):
        await persist_people_portal_payload(in_memory_store, portal())
    assert await in_memory_store.list('recruiting_candidates') == []
    assert await in_memory_store.list('recruiting_sources') == []


async def test_atomic_review_rolls_back_state_and_history_on_audit_failure(empty_app_client, in_memory_store, monkeypatch):
    await ingest_payload(analytics())
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    original = in_memory_store.add
    async def fail(collection, item):
        if collection == 'audit_log':
            raise RuntimeError('simulated audit write failure')
        return await original(collection, item)
    monkeypatch.setattr(in_memory_store, 'add', fail)
    with pytest.raises(RuntimeError):
        await empty_app_client.post('/recruiting/reviews', json={'run_id': run.run_id, 'member_login': 'git-account', 'decision': 'confirm'})
    assert await in_memory_store.recruiting_reviews_for_run(run.run_id) == []
    assert (await in_memory_store.recruiting_run(run.run_id)).reviewed_count == 0
    assert (await in_memory_store.recruiting_signal(run.run_id, 'git-account')).review_status == 'pending'


async def test_same_reviewer_revisions_are_not_independent_calibration(empty_app_client, in_memory_store):
    await ingest_payload(analytics())
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    for decision in ['confirm', 'defer']:
        response = await empty_app_client.post('/recruiting/reviews', json={
            'run_id': run.run_id, 'member_login': 'git-account', 'decision': decision, 'note': 'Revisiting evidence.'})
        assert response.status_code == 201
    assert len(response.json()['candidate']['review_history']) == 2
    audit = (await empty_app_client.get('/recruiting/audit')).json()['audit']
    assert audit['calibration']['multi_reviewer_candidates'] == 0
    assert audit['calibration']['reviewer_count'] == 1


async def test_no_employer_is_automatically_removed_or_shortlisted(empty_app_client, in_memory_store):
    await persist_people_portal_payload(in_memory_store, portal([{'member_login': 'one', 'prior_employers': ['Google'], 'member_stats': {'commits': 2}}]))
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    assert run.candidate_count == 1 and run.excluded_candidates == []
    assert (await empty_app_client.get('/recruiting/shortlist')).json()['candidates'] == []
    await empty_app_client.post('/recruiting/reviews', json={'run_id': run.run_id, 'member_login': 'one', 'decision': 'confirm'})
    assert (await empty_app_client.get('/recruiting/shortlist')).json()['candidates'] == []


async def test_production_auth_is_fail_closed_and_reviewer_identity_cannot_be_spoofed(empty_app_client, in_memory_store, monkeypatch):
    await ingest_payload(analytics())
    run = await run_recruiting_pipeline(in_memory_store, settings=Settings())
    token = 'operator-secret-at-least-24-characters'
    settings = Settings(environment='production', api_tokens={'reviewer-a': token})
    monkeypatch.setattr('backend.auth.get_settings', lambda: settings)
    for path in ['/snapshots/latest', '/analytics/members', '/recruiting/overview', '/audit']:
        assert (await empty_app_client.get(path)).status_code == 401
    response = await empty_app_client.post('/recruiting/reviews', headers={'Authorization': f'Bearer {token}', 'X-Reviewer-Id': 'spoofed'}, json={
        'run_id': run.run_id, 'member_login': 'git-account', 'decision': 'confirm'})
    assert response.status_code == 201
    assert response.json()['review']['reviewer_user_id'] == 'reviewer-a'
    assert (await empty_app_client.post('/recruiting/run')).status_code == 401


async def test_artifact_auth_and_path_containment(tmp_path, monkeypatch):
    run = tmp_path / 'run'; run.mkdir(); (run / 'analytics.json').write_text('{}')
    outside = tmp_path.parent / f'{tmp_path.name}-secret.json'; outside.write_text('secret')
    (run / 'member-profiles.json').symlink_to(outside)
    settings = Settings(environment='production', artifact_root=str(tmp_path))
    monkeypatch.setattr('backend.auth.get_settings', lambda: settings)
    app = FastAPI(); app.include_router(artifact_router); app.dependency_overrides[get_settings] = lambda: settings
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
        assert (await client.get('/artifacts/run/analytics.json')).status_code == 401
        app.dependency_overrides[get_current_user] = lambda: None
        assert (await client.get('/artifacts/run/analytics.json')).status_code == 200
        assert (await client.get('/artifacts/run/member-profiles.json')).status_code == 404
        assert (await client.get('/artifacts/run/.env')).status_code == 404


def test_export_is_byte_deterministic_and_drops_graduation_proxy(pipeline):
    root, _ = pipeline
    manifest = root / 'llm-ranking-export/manifest.json'
    before = manifest.read_bytes()
    build_export(Namespace(root=root, output=None))
    assert manifest.read_bytes() == before
    cards = [json.loads(line) for line in (manifest.parent / 'members.jsonl').read_text().splitlines()]
    assert all('expected_grad' not in card['member'] and 'major' not in card['member'] for card in cards)


def test_pipeline_publishes_complete_historical_run_with_exports(pipeline, tmp_path, monkeypatch):
    import run_pipeline
    root, _ = pipeline
    output = tmp_path / 'published'
    original_run = subprocess.run
    def fake_collector(command, **kwargs):
        if str(run_pipeline.COLLECTOR) in command:
            path = Path(command[command.index('--json') + 1]); path.write_text((root / 'analytics.json').read_text())
            for option in ['--markdown']:
                Path(command[command.index(option) + 1]).write_text('synthetic')
            return subprocess.CompletedProcess(command, 0)
        return original_run(command, **kwargs)
    monkeypatch.setattr(run_pipeline.subprocess, 'run', fake_collector)
    monkeypatch.setattr(run_pipeline, 'interpreter', lambda: sys.executable)
    monkeypatch.setenv('PHI_GITEA_API_TOKEN', 'synthetic-test-token')
    monkeypatch.setattr(sys, 'argv', ['run_pipeline.py', '--env-file', str(tmp_path / 'absent.env'), '--api-history', '--no-blame', '--output-dir', str(output), '--peopleportal-zip', str(root / 'peopleportal.zip')])
    assert run_pipeline.main() == 0
    latest = output / 'latest'; assert latest.is_symlink()
    manifest = json.loads((latest / 'pipeline-manifest.json').read_text())
    assert latest.resolve().name == manifest['run_id']
    for name in ['member-profiles.json', 'recruiting-source.json', 'identity-review.json', 'llm-ranking-export/manifest.json']:
        assert (latest.resolve() / name).exists()
    assert json.loads((latest / 'recruiting-source.json').read_text())['source']['gitea_run_id'] == manifest['run_id']


def test_pruning_only_deletes_completed_timestamp_runs(tmp_path):
    from run_pipeline import prune_runs
    for name in ['20260101T000000Z', '20260102T000000Z', '20260103T000000Z', 'personal-notes', '.staging']:
        directory = tmp_path / name; directory.mkdir(); (directory / 'pipeline-manifest.json').write_text('{}')
    (tmp_path / 'latest').symlink_to('20260101T000000Z')
    assert prune_runs(tmp_path, 1) == ['20260102T000000Z']
    assert (tmp_path / 'personal-notes').exists() and (tmp_path / '.staging').exists()
    assert (tmp_path / 'latest').exists()


def test_static_proxy_denies_private_files_and_preserves_artifact_security(tmp_path, monkeypatch):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.error import HTTPError
    from urllib.request import Request, urlopen
    from scripts import serve_local

    class Upstream(BaseHTTPRequestHandler):
        def do_GET(self):
            if self.path != '/artifacts/run/member-profiles.json':
                self.send_error(404)
                return
            assert self.headers.get('Authorization') == 'Bearer synthetic-operator'
            assert self.path == '/artifacts/run/member-profiles.json'
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Security-Policy', 'sandbox')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.end_headers()
            self.wfile.write(b'{"profiles": []}\n')

        def log_message(self, *args):
            pass

    (tmp_path / '.env').write_text('not-public')
    (tmp_path / 'index.html').write_text('public-ui')
    (tmp_path / 'assets').mkdir()
    monkeypatch.setattr(serve_local, 'PROJECT_ROOT', tmp_path)
    upstream = ThreadingHTTPServer(('127.0.0.1', 0), Upstream)
    monkeypatch.setattr(serve_local.LocalHorizonHandler, 'backend_base', f'http://127.0.0.1:{upstream.server_port}')
    proxy = ThreadingHTTPServer(('127.0.0.1', 0), serve_local.LocalHorizonHandler)
    servers = (upstream, proxy)
    for server in servers:
        threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        base = f'http://127.0.0.1:{proxy.server_port}'
        for path in ('/.env', '/assets/', '/data/horizon/source.zip'):
            with pytest.raises(HTTPError):
                urlopen(base + path, timeout=3)
        with pytest.raises(HTTPError):
            urlopen(base + '/data/horizon/run/member-profiles.csv', timeout=3)
        request = Request(base + '/data/horizon/run/member-profiles.json', headers={'Authorization': 'Bearer synthetic-operator'})
        with urlopen(request, timeout=3) as response:
            assert response.headers['Content-Security-Policy'] == 'sandbox'
            assert response.headers['X-Content-Type-Options'] == 'nosniff'
            assert response.read() == b'{"profiles": []}\n'
    finally:
        for server in servers:
            server.shutdown()
            server.server_close()


def test_analytics_collector_has_no_csv_writer():
    from scripts import member_analytics
    assert not hasattr(member_analytics, 'write_csv')
