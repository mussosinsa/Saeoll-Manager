import os
os.environ['OMA_DEMO']='true'
os.environ['OMA_COOKIE_SECURE']='false'
from fastapi.testclient import TestClient
from backend.app import app

def test_snapshot_pages():
    with TestClient(app) as c:
        assert c.post('/api/auth/login',json={'username':'demo','password':'demo'}).status_code==200
        r=c.get('/api/inventory/storagedomains/page?page=1&page_size=1')
        assert r.status_code==200
        assert r.json()['total']==1

def test_write_remains_blocked():
    with TestClient(app) as c:
        auth=c.post('/api/auth/login',json={'username':'demo','password':'demo'}).json()
        assert c.post('/api/vms/v1/actions/stop',headers={'x-csrf-token':auth['csrf']}).status_code==403

def test_capabilities():
    with TestClient(app) as c:
        j=c.get('/api/capabilities').json()
        assert j['version']== '1.8.0'
        assert j['writes_enabled'] is False
