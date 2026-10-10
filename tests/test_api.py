import os
os.environ['OMA_DEMO']='true'
os.environ['OMA_COOKIE_SECURE']='false'
from fastapi.testclient import TestClient
from backend.app import app

def test_health():
    r=TestClient(app).get('/api/health/live')
    assert r.status_code==200

def test_auth_required():
    assert TestClient(app).get('/api/inventory/vms').status_code==401

def test_demo_login_inventory_and_write_block():
    with TestClient(app) as c:
        r=c.post('/api/auth/login',json={'username':'demo','password':'demo'})
        assert r.status_code==200
        token=r.json()['csrf']
        assert len(c.get('/api/inventory/vms').json()['items'])==3
        assert c.post('/api/vms/v1/actions/start',headers={'x-csrf-token':token}).status_code==403
        assert c.post('/api/auth/logout',headers={'x-csrf-token':token}).status_code==200
