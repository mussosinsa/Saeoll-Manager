import os
os.environ['OMA_DEMO']='true'
os.environ['OMA_COOKIE_SECURE']='false'
from fastapi.testclient import TestClient
from backend.app import app

def test_capabilities_explicitly_readonly():
    with TestClient(app) as c:
        r=c.get('/api/capabilities')
        assert r.status_code==200
        assert r.json()['writes_enabled'] is False
        assert r.json()['sso_verified'] is False

def test_demo_page_and_limit():
    with TestClient(app) as c:
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code==200
        p1=c.get('/api/inventory/vms/page?page=1&page_size=2').json()
        p2=c.get('/api/inventory/vms/page?page=2&page_size=2').json()
        assert len(p1['items'])==2 and p1['has_more'] is True
        assert len(p2['items'])==1 and p2['has_more'] is False
        assert c.get('/api/inventory/vms/page?page_size=201').status_code==422

def test_bad_action_always_blocked():
    with TestClient(app) as c:
        login=c.post('/api/auth/login',json={'username':'demo','password':'demo'}).json()
        r=c.post('/api/vms/v1/actions/start',headers={'x-csrf-token':login['csrf']})
        assert r.status_code==403
