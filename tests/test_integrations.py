import json
import os
import shutil
import ssl

import certifi
import httpx
import pytest
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from backend import integrations as i


@pytest.fixture
def setup(tmp_path, monkeypatch):
    root = tmp_path/'credentials'
    root.mkdir()
    ca = root/'ca.pem'
    shutil.copyfile(certifi.where(), ca)
    token = root/'token'
    token.write_text('test-service-account-token')
    engine_path, cluster_path = tmp_path/'engine.json', tmp_path/'clusters.json'
    monkeypatch.setenv('OMA_CONFIG_CREDENTIAL_ROOT', str(root))
    monkeypatch.setenv('OMA_ENGINE_CONFIG_FILE', str(engine_path))
    monkeypatch.setenv('OMA_K8S_CONFIG_FILE', str(cluster_path))
    monkeypatch.setenv('OMA_CONFIG_ADMINS', 'admin@internal')
    active = {'api_url':'https://engine.example/ovirt-engine/api', 'ca_file':str(ca),
              'sso_token_url':'https://engine.example/ovirt-engine/sso/oauth/token',
              'sso_scope':'ovirt-app-api', 'token_login':True}
    cluster = {'id':'prod','name':'Production','server':'https://cluster.example:6443','ca_file':str(ca),
               'token_file':str(token),'users':{'admin@internal':{'namespaces':['team']}},'node_vm_map':{'worker':'vm-123'}}
    def session(req):
        username = req.headers.get('test-user')
        if not username:
            raise HTTPException(401, 'Authentication required')
        return {'username':username,'demo':username=='demo','csrf':'test-csrf'}
    def csrf(req, s):
        if req.headers.get('x-csrf-token') != s['csrf']:
            raise HTTPException(403, 'CSRF token invalid')
    audits=[]
    app=FastAPI()
    app.include_router(i.router(session,csrf,lambda *a,**k: audits.append((a,k)),lambda:active))
    return TestClient(app), active, cluster, engine_path, cluster_path, audits


ADMIN={'test-user':'admin@internal','x-csrf-token':'test-csrf'}


def test_admin_authentication_and_demo_cannot_edit(setup):
    c, active, _, ep, _, _=setup
    assert c.get('/api/integrations/status').status_code==401
    for user in ['reader','demo']:
        h={'test-user':user,'x-csrf-token':'test-csrf'}
        assert c.get('/api/integrations/status',headers=h).json()['can_edit'] is False
        assert c.get('/api/integrations/settings',headers=h).status_code==403
        assert c.put('/api/integrations/engine',headers=h,json={'engine':active,'revision':'x'}).status_code==403
    assert not ep.exists()


def test_missing_admin_binding_and_csrf_fail_closed(setup,monkeypatch):
    c, active, _, ep, _, _=setup
    revision=c.get('/api/integrations/settings',headers=ADMIN).json()['engine_revision']
    assert c.put('/api/integrations/engine',headers={'test-user':'admin@internal'},json={'engine':active,'revision':revision}).status_code==403
    monkeypatch.delenv('OMA_CONFIG_ADMINS')
    assert c.get('/api/integrations/settings',headers=ADMIN).status_code==403
    assert not ep.exists()


def test_engine_atomic_save_revision_restart_and_startup_load(setup):
    c, active, _, ep, _, audits=setup
    initial=c.get('/api/integrations/settings',headers=ADMIN).json()
    changed=dict(active,api_url='https://new.example/ovirt-engine/api',sso_token_url='https://new.example/ovirt-engine/sso/oauth/token')
    body={'engine':changed,'revision':initial['engine_revision']}
    response=c.put('/api/integrations/engine',headers=ADMIN,json=body)
    assert response.status_code==200 and response.json()['restart_required']
    assert os.stat(ep).st_mode & 0o777 == 0o600
    assert i.load_engine_settings()==changed
    persisted=c.get('/api/integrations/settings',headers=ADMIN).json()
    assert persisted['engine']==changed and persisted['active_engine']==active and persisted['restart_required']
    assert c.put('/api/integrations/engine',headers=ADMIN,json=body).status_code==409
    assert json.loads(ep.read_text())['engine']==changed
    assert audits[-1][0][0]=='integration.engine.save'


def test_kubernetes_save_rotation_metadata_only_and_remove(setup):
    c, _, cluster, _, cp, _=setup
    revision=c.get('/api/integrations/settings',headers=ADMIN).json()['clusters_revision']
    r=c.put('/api/integrations/kubernetes',headers=ADMIN,json={'clusters':[cluster],'revision':revision})
    assert r.status_code==200 and r.json()['restart_required'] is False
    from backend.kubernetes import configurations
    assert configurations()[0]['id']=='prod'
    loaded=c.get('/api/integrations/settings',headers=ADMIN)
    assert 'test-service-account-token' not in loaded.text
    assert 'test-service-account-token' not in cp.read_text()
    assert loaded.json()['clusters'][0]['users']['admin@internal']['namespaces']==['team']
    assert c.put('/api/integrations/kubernetes',headers=ADMIN,json={'clusters':[],'revision':r.json()['revision']}).status_code==200
    assert configurations()==[]


@pytest.mark.parametrize('field,value',[('api_url','http://engine.example/api'),('api_url','https://user:password@engine.example/api'),('sso_token_url','https://attacker.example/token')])
def test_engine_rejects_insecure_or_mismatched_endpoints(setup,field,value):
    c, active, _, ep, _, _=setup
    response=c.put('/api/integrations/engine',headers=ADMIN,json={'engine':dict(active,**{field:value}),'revision':'x'})
    assert response.status_code==422 and not ep.exists()


def test_credential_root_and_symlink_escape(setup,tmp_path):
    c, _, cluster, _, cp, _=setup
    outside=tmp_path/'outside-token';outside.write_text('outside-token')
    link=tmp_path/'credentials'/'linked-token';link.symlink_to(outside)
    revision=c.get('/api/integrations/settings',headers=ADMIN).json()['clusters_revision']
    for path in [str(outside),str(link),'/etc/passwd']:
        r=c.put('/api/integrations/kubernetes',headers=ADMIN,json={'clusters':[dict(cluster,token_file=path)],'revision':revision})
        assert r.status_code==422 and 'outside-token' not in r.text and not cp.exists()


def test_duplicate_clusters_and_wildcard_user_rejected(setup):
    c, _, cluster, _, cp, _=setup
    assert c.put('/api/integrations/kubernetes',headers=ADMIN,json={'clusters':[cluster,cluster],'revision':'x'}).status_code==422
    cluster['users']={'*':{'namespaces':['*']}}
    assert c.put('/api/integrations/kubernetes',headers=ADMIN,json={'clusters':[cluster],'revision':'x'}).status_code==422
    assert not cp.exists()


def test_engine_probe_never_forwards_existing_credentials(setup,monkeypatch):
    c, active, _, _, _, _=setup
    original=httpx.AsyncClient
    seen=[]
    def response(request):
        seen.append(request)
        return httpx.Response(401, text='private upstream detail')
    def client(**kwargs):
        assert isinstance(kwargs['verify'],ssl.SSLContext) and kwargs['verify'].check_hostname
        assert kwargs['follow_redirects'] is False and kwargs['trust_env'] is False
        return original(**kwargs,transport=httpx.MockTransport(response))
    monkeypatch.setattr(i.httpx,'AsyncClient',client)
    r=c.post('/api/integrations/engine/check',headers=ADMIN,json=active)
    assert r.status_code==200 and r.json()['authentication_checked'] is False
    assert 'authorization' not in seen[0].headers and 'cookie' not in seen[0].headers
    assert 'private upstream detail' not in r.text


def test_cluster_probe_path_is_bounded_and_permission_failure_preserved(setup,monkeypatch):
    c, _, cluster, _, _, _=setup
    from backend import kubernetes
    calls=[]
    async def fetch(config,path,params):
        calls.append((path,params))
        return {'items':[]}
    monkeypatch.setattr(kubernetes,'fetch',fetch)
    r=c.post('/api/integrations/kubernetes/check',headers=ADMIN,json=cluster)
    assert r.status_code==200
    assert calls==[('/api/v1/namespaces/team/pods',{'limit':1})]
    async def denied(*a,**k):
        raise HTTPException(403,'Kubernetes service account lacks permission')
    monkeypatch.setattr(kubernetes,'fetch',denied)
    assert c.post('/api/integrations/kubernetes/check',headers=ADMIN,json=cluster).status_code==403


@pytest.mark.parametrize('contents', ['invalid json', '', 'null'])
def test_bad_engine_file_stops_startup(setup, contents):
    _, _, _, ep, _, _=setup
    ep.write_text(contents)
    with pytest.raises(RuntimeError):
        i.load_engine_settings()


def test_real_app_demo_cannot_write_settings():
    from backend.app import app
    with TestClient(app) as c:
        r=c.post('/api/auth/login',json={'username':'demo','password':'demo'})
        assert r.status_code==200
        assert c.get('/api/integrations/status').json()=={'can_edit':False,'demo':True}
        assert c.get('/api/integrations/settings').status_code==403


def test_new_registry_without_file_starts_empty(setup):
    from backend.kubernetes import configurations
    assert configurations() == []
