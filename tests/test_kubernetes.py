import json
import ssl

import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend import kubernetes as k


@pytest.fixture
def configured(tmp_path, monkeypatch):
    config = {"clusters": [{"id": "prod", "server": "https://cluster.example:6443",
        "ca_file": str(tmp_path / 'ca.pem'), "token_file": str(tmp_path / 'token'),
        "users": {"reader": {"namespaces": ["team"], "logs": True, "secrets": True,
            "configmaps": True, "cluster_resources": True, "rbac": True},
            "limited": {"namespaces": ["team"]}}, "node_vm_map": {"worker": "vm-123"}}]}
    file = tmp_path / 'clusters.json'
    file.write_text(json.dumps(config))
    monkeypatch.setenv('OMA_K8S_CONFIG_FILE', str(file))
    calls, audits = [], []
    async def fetch(cluster, path, params=None, text=False):
        calls.append((cluster['id'], path, params, text))
        if text:
            return 'bounded log'
        return {"items": [], "metadata": {"continue": "next-page"}}
    monkeypatch.setattr(k, 'fetch', fetch)
    app = FastAPI()
    def session(request):
        username = request.headers.get('test-user')
        if not username:
            raise HTTPException(401, 'Authentication required')
        return {"username": username, "demo": username == 'demo'}
    app.include_router(k.router(session, lambda *args, **kwargs: audits.append((args, kwargs))))
    return TestClient(app), calls, audits, config, file


def test_auth_and_cluster_visibility(configured):
    c, calls, _, _, _ = configured
    assert c.get('/api/kubernetes/clusters').status_code == 401
    assert c.get('/api/kubernetes/clusters', headers={'test-user': 'outsider'}).json()['items'] == []
    body = c.get('/api/kubernetes/clusters', headers={'test-user': 'reader'}).json()
    assert body['items'][0]['id'] == 'prod'
    assert 'token_file' not in str(body) and 'cluster.example' not in str(body)
    assert c.get('/api/kubernetes/clusters/prod/resources/nodes', headers={'test-user': 'outsider'}).status_code == 404
    assert calls == []


@pytest.mark.parametrize('suffix', ['resources/nodes', 'resources/clusterroles',
    'namespaces/other/resources/pods', 'namespaces/team/resources/secrets',
    'namespaces/team/resources/configmaps', 'namespaces/team/resources/roles',
    'namespaces/team/pods/pod/logs?container=app'])
def test_access_denied_before_upstream(configured, suffix):
    c, calls, _, _, _ = configured
    assert c.get('/api/kubernetes/clusters/prod/' + suffix, headers={'test-user': 'limited'}).status_code == 403
    assert not calls


def test_pagination_and_resource_allowlist(configured):
    c, calls, _, _, _ = configured
    h = {'test-user': 'reader'}
    url = '/api/kubernetes/clusters/prod/namespaces/team/resources/'
    r = c.get(url + 'deployments?cursor=opaque', headers=h)
    assert r.status_code == 200 and r.json()['continue'] == 'next-page'
    assert calls[-1][1:3] == ('/apis/apps/v1/namespaces/team/deployments', {'limit': 100, 'continue': 'opaque'})
    assert c.get(url + 'serviceaccounts', headers=h).status_code == 404
    assert c.post(url + 'deployments', headers=h).status_code == 405
    assert c.get(url + 'pods?cursor=' + 'x' * 4097, headers=h).status_code == 422


def test_logs_limits_and_audit(configured):
    c, calls, audits, _, _ = configured
    h = {'test-user': 'reader'}
    url = '/api/kubernetes/clusters/prod/namespaces/team/pods/pod/logs'
    assert c.get(url + '?container=app&tail_lines=1001', headers=h).status_code == 422
    assert c.get(url + '?container=..', headers=h).status_code == 422
    r = c.get(url + '?container=app&previous=true', headers=h)
    assert r.json()['text'] == 'bounded log'
    assert calls[-1][2]['limitBytes'] == 65536 and calls[-1][2]['previous'] == 'true'
    assert audits[-1][0][0] == 'kubernetes.logs'
    assert 'bounded log' not in str(audits)


def test_secret_projection_and_mapping():
    raw = {'metadata': {'name': 'credential', 'annotations': {'copy': 'private-value'}},
           'data': {'password': 'private-value'}, 'stringData': {'password': 'private-value'}}
    result = k.project(raw, 'secrets', {})
    assert result['keys'] == ['password'] and 'private-value' not in str(result)
    pod = {'metadata': {'name': 'pod'}, 'spec': {'containers': [{'name': 'app', 'env': [{'value': 'private-value'}]}]},
           'status': {'containerStatuses': [{'name': 'app', 'ready': False, 'restartCount': 4}]}}
    result = k.project(pod, 'pods', {})
    assert 'private-value' not in str(result) and result['containers'][0]['restartCount'] == 4
    node = k.project({'metadata': {'name': 'worker'}}, 'nodes', {'node_vm_map': {'worker': 'vm-123'}})
    assert node['vm_id'] == 'vm-123'


def test_demo_isolation(configured):
    c, calls, _, _, file = configured
    file.write_text('invalid config must not affect demo')
    h = {'test-user': 'demo'}
    assert c.get('/api/kubernetes/clusters', headers=h).json()['items'][0]['id'] == 'demo'
    base = '/api/kubernetes/clusters/demo'
    nodes = c.get(base + '/resources/nodes', headers=h).json()['items']
    assert len(nodes) == 3 and nodes[1]['vm_id'] == 'v2'
    pods = c.get(base + '/namespaces/default/resources/pods', headers=h).json()['items']
    assert len(pods) == 4 and pods[0]['containers'][0]['ready']
    secret = c.get(base + '/namespaces/default/resources/secrets', headers=h).json()
    assert 'never-return-this' not in str(secret)
    assert c.get(base + '/namespaces/default/resources/podmetrics', headers=h).json()['available'] is False
    assert c.get(base + '/namespaces/default/pods/document-search/logs?container=app', headers=h).status_code == 200
    assert not calls


def test_metrics_missing_vs_forbidden(configured, monkeypatch):
    c, _, _, _, _ = configured
    code = 404
    async def fail(*args, **kwargs):
        raise HTTPException(code, 'unavailable')
    monkeypatch.setattr(k, 'fetch', fail)
    url = '/api/kubernetes/clusters/prod/namespaces/team/resources/podmetrics'
    assert c.get(url, headers={'test-user': 'reader'}).json()['available'] is False
    code = 403
    assert c.get(url, headers={'test-user': 'reader'}).status_code == 403


def test_invalid_config_fails_closed(configured):
    c, _, _, config, file = configured
    config['clusters'][0]['server'] = 'http://insecure.example'
    file.write_text(json.dumps(config))
    assert c.get('/api/kubernetes/clusters', headers={'test-user': 'reader'}).status_code == 503


def test_secret_route_sanitizes_and_audits(configured, monkeypatch):
    c, _, audits, _, _ = configured
    async def fetch(*args, **kwargs):
        return {'items': [{'metadata': {'name': 's', 'annotations': {'secret': 'sensitive'}},
                           'data': {'key': 'sensitive'}}]}
    monkeypatch.setattr(k, 'fetch', fetch)
    r = c.get('/api/kubernetes/clusters/prod/namespaces/team/resources/secrets', headers={'test-user': 'reader'})
    assert r.status_code == 200 and 'sensitive' not in r.text
    assert audits[-1][0][0] == 'kubernetes.read.secrets'


def test_upstream_tls_token_rotation_and_error_redaction(tmp_path, monkeypatch):
    import asyncio
    import certifi
    original = httpx.AsyncClient
    token = tmp_path / 'token'
    token.write_text('first-token')
    cluster = {'server': 'https://cluster.example:6443', 'ca_file': certifi.where(), 'token_file': str(token)}
    seen = []
    status = 200
    def respond(request):
        seen.append(request)
        return httpx.Response(status, json={'items': [], 'private-error': 'never-forward-upstream-error'})
    def client(**kwargs):
        assert isinstance(kwargs['verify'], ssl.SSLContext)
        assert kwargs['verify'].verify_mode == ssl.CERT_REQUIRED
        assert kwargs['verify'].check_hostname
        assert kwargs['follow_redirects'] is False and kwargs['trust_env'] is False
        return original(**kwargs, transport=httpx.MockTransport(respond))
    monkeypatch.setattr(k.httpx, 'AsyncClient', client)
    assert asyncio.run(k.fetch(cluster, '/api/v1/nodes', {'limit': 100}))['items'] == []
    assert seen[-1].headers['authorization'] == 'Bearer first-token'
    token.write_text('rotated-token')
    asyncio.run(k.fetch(cluster, '/api/v1/nodes'))
    assert seen[-1].headers['authorization'] == 'Bearer rotated-token'
    for code, expected in [(401, 502), (403, 403), (404, 404), (500, 502), (302, 502)]:
        status = code
        with pytest.raises(HTTPException) as error:
            asyncio.run(k.fetch(cluster, '/api/v1/nodes'))
        assert error.value.status_code == expected
        assert 'never-forward' not in error.value.detail and 'token' not in error.value.detail


def test_upstream_log_response_bound(tmp_path, monkeypatch):
    import asyncio
    import certifi
    original = httpx.AsyncClient
    token = tmp_path / 'token'
    token.write_text('test-token')
    cluster = {'server': 'https://cluster.example', 'ca_file': certifi.where(), 'token_file': str(token)}
    def client(**kwargs):
        return original(**kwargs, transport=httpx.MockTransport(lambda request: httpx.Response(200, content=b'x' * 65537)))
    monkeypatch.setattr(k.httpx, 'AsyncClient', client)
    with pytest.raises(HTTPException) as error:
        asyncio.run(k.fetch(cluster, '/api/v1/namespaces/team/pods/pod/log', text=True))
    assert error.value.status_code == 502


def test_real_app_session_required_and_demo_logout():
    from backend.app import app
    with TestClient(app) as c:
        assert c.get('/api/kubernetes/clusters').status_code == 401
        login = c.post('/api/auth/login', json={'username': 'demo', 'password': 'demo'})
        assert login.status_code == 200
        assert c.get('/api/kubernetes/clusters').json()['items'][0]['id'] == 'demo'
        assert c.post('/api/auth/logout', headers={'x-csrf-token': login.json()['csrf']}).status_code == 200
        assert c.get('/api/kubernetes/clusters').status_code == 401


def test_node_pod_drilldown(configured):
    c, calls, _, _, _ = configured
    url = '/api/kubernetes/clusters/prod/namespaces/team/resources/pods?node=worker-1'
    assert c.get(url, headers={'test-user': 'reader'}).status_code == 200
    assert calls[-1][2]['fieldSelector'] == 'spec.nodeName=worker-1'
    url = '/api/kubernetes/clusters/demo/namespaces/default/resources/pods?node=worker-1'
    rows = c.get(url, headers={'test-user': 'demo'}).json()['items']
    assert len(rows) == 2 and all(r['node'] == 'worker-1' for r in rows)


def test_cluster_failure_isolated(configured, monkeypatch):
    c, _, _, config, file = configured
    second = dict(config['clusters'][0], id='second', server='https://second.example')
    config['clusters'].append(second)
    file.write_text(json.dumps(config))
    async def fetch(cluster, *args, **kwargs):
        if cluster['id'] == 'prod':
            raise HTTPException(502, 'Connection failed')
        return {'items': [{'metadata': {'name': 'healthy'}}]}
    monkeypatch.setattr(k, 'fetch', fetch)
    h = {'test-user': 'reader'}
    assert len(c.get('/api/kubernetes/clusters', headers=h).json()['items']) == 2
    assert c.get('/api/kubernetes/clusters/prod/resources/nodes', headers=h).status_code == 502
    result = c.get('/api/kubernetes/clusters/second/resources/nodes', headers=h)
    assert result.status_code == 200 and result.json()['items'][0]['name'] == 'healthy'
